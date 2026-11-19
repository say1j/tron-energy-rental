import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, settingsFromEnv } from "../src/index.js";
import type { FetchLike } from "../src/api.js";
import type { ToolSettings } from "../src/tools.js";

const SENDER = "TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm";
const QUOTE_ID = "8bb302b8-c245-48a6-94f7-90f00652a32d";

type Call = { url: string; method: string; headers: Headers; body: unknown };

function fakeFetch(routes: Record<string, unknown>, calls: Call[]): FetchLike {
  return async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({
      url,
      method,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const key = `${method} ${new URL(url).pathname}`;
    if (!(key in routes)) return Response.json({ code: "NOT_FOUND", title: "Route not found" }, { status: 404 });
    return Response.json(routes[key], { status: method === "POST" ? 201 : 200 });
  };
}

function settings(overrides: Partial<ToolSettings>, fetch: FetchLike): ToolSettings {
  return {
    apiBase: "https://api.example",
    siteBase: "https://site.example",
    timeoutMs: 1_000,
    fetch,
    maxPaymentUsd: "$5",
    ...overrides,
  };
}

async function connect(toolSettings: ToolSettings) {
  const server = createServer(toolSettings);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content[0]!.text;
}

test("public tools need no key and spending tools stay hidden until configured", async () => {
  const anonymous = await connect(settings({}, fakeFetch({}, [])));
  assert.deepEqual(
    (await anonymous.listTools()).tools.map((tool) => tool.name).sort(),
    ["create_x402_quote", "get_energy_prices", "get_x402_rental"],
  );

  const configured = await connect(settings({ apiKey: "k", payingFetch: fakeFetch({}, []) }, fakeFetch({}, [])));
  const tools = (await configured.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "check_transfer_energy",
    "create_x402_quote",
    "get_account",
    "get_energy_prices",
    "get_rental",
    "get_x402_rental",
    "pay_x402_quote",
    "rent_energy",
  ]);
  for (const name of ["pay_x402_quote", "rent_energy"]) {
    const tool = tools.find((candidate) => candidate.name === name)!;
    assert.equal(tool.annotations?.destructiveHint, true, `${name} must be marked as spending money`);
    assert.match(tool.description ?? "", /confirm/i);
  }
  for (const name of ["get_energy_prices", "get_x402_rental", "get_account", "check_transfer_energy", "get_rental"]) {
    assert.equal(tools.find((candidate) => candidate.name === name)!.annotations?.readOnlyHint, true);
  }
});

test("prices come from the public snapshot with a USD reference", async () => {
  const calls: Call[] = [];
  const client = await connect(settings({}, fakeFetch({
    "GET /public-prices.json": {
      version: 1,
      trx_usd: { price_usd: "0.31", observed_at: "2026-11-19T15:00:00.000Z" },
      rates: [{
        energy_amount: 65_000,
        duration_seconds: 3_600,
        price_trx: "2.1489",
        average_commission_trx: "6.5",
        savings_percent: "66.94",
        observed_at: "2026-11-19T15:00:00.000Z",
      }],
    },
  }, calls)));
  const result = await client.callTool({ name: "get_energy_prices", arguments: {} });
  const body = JSON.parse(text(result));
  assert.equal(calls[0]!.url, "https://site.example/public-prices.json");
  assert.equal(body.rates[0].price_trx, "2.1489");
  assert.equal(body.rates[0].price_usd_reference, "~$0.67");
  assert.equal(body.rates[0].trx_burned_without_energy, "6.5");
});

test("x402 quotes validate the address before any request and explain payment", async () => {
  const calls: Call[] = [];
  const quote = { quote_id: QUOTE_ID, status: "payment_required", valid_until: "2026-11-19T15:10:00.000Z" };
  const client = await connect(settings({}, fakeFetch({ "POST /v1/x402/quotes": quote }, calls)));

  const invalid = await client.callTool({ name: "create_x402_quote", arguments: { target_address: "T".padEnd(34, "0") } });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 0);

  const created = await client.callTool({ name: "create_x402_quote", arguments: { target_address: SENDER } });
  assert.equal(created.isError, undefined);
  assert.deepEqual(calls[0]!.body, { target_address: SENDER, energy_amount: 65_000, duration_seconds: 3_600 });
  assert.equal(calls[0]!.headers.get("authorization"), null, "x402 quotes are anonymous");
  assert.match(JSON.parse(text(created)).how_to_pay, /TRONENERGYFROG_EVM_PRIVATE_KEY/);
});

test("pay_x402_quote pays only a quote that still needs payment", async () => {
  const calls: Call[] = [];
  const paid: Call[] = [];
  const statusUrl = `GET /v1/x402/rentals/${QUOTE_ID}`;
  const routes = { [statusUrl]: { quote_id: QUOTE_ID, status: "succeeded" } };
  const client = await connect(settings({ payingFetch: fakeFetch({}, paid) }, fakeFetch(routes, calls)));
  const result = await client.callTool({ name: "pay_x402_quote", arguments: { quote_id: QUOTE_ID } });
  assert.match(text(result), /does not need payment/);
  assert.equal(paid.length, 0);

  routes[statusUrl] = { quote_id: QUOTE_ID, status: "payment_required" };
  const payable = await connect(settings({
    payingFetch: fakeFetch({ [`POST /v1/x402/rentals/${QUOTE_ID}`]: { quote_id: QUOTE_ID, status: "settling" } }, paid),
  }, fakeFetch(routes, calls)));
  const settled = await payable.callTool({ name: "pay_x402_quote", arguments: { quote_id: QUOTE_ID } });
  assert.equal(settled.isError, undefined, text(settled));
  assert.equal(paid.length, 1);
  assert.equal(paid[0]!.method, "POST");
});

test("rent_energy sends the API key and a reusable idempotency key", async () => {
  const calls: Call[] = [];
  const client = await connect(settings({ apiKey: "secret-key" }, fakeFetch({
    "POST /v1/rental/auto": { id: "op", status: "pending" },
  }, calls)));
  const result = await client.callTool({
    name: "rent_energy",
    arguments: { target_address: SENDER, energy_amount: 130_000, idempotency_key: "order-12345" },
  });
  assert.equal(result.isError, undefined, text(result));
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer secret-key");
  assert.equal(calls[0]!.headers.get("idempotency-key"), "order-12345");
  assert.deepEqual(calls[0]!.body, { target_address: SENDER, energy_amount: 130_000, duration_seconds: 3_600 });
  assert.equal(JSON.parse(text(result)).idempotency_key, "order-12345");
});

test("API errors reach the agent as tool errors with their code", async () => {
  const client = await connect(settings({}, async () =>
    Response.json({ code: "X402_QUOTE_NOT_FOUND", title: "x402 quote not found." }, { status: 404 })));
  const result = await client.callTool({ name: "get_x402_rental", arguments: { quote_id: QUOTE_ID } });
  assert.equal(result.isError, true);
  assert.equal(text(result), "X402_QUOTE_NOT_FOUND: x402 quote not found.");
});

test("environment settings reject malformed secrets and caps", () => {
  assert.throws(() => settingsFromEnv({ TRONENERGYFROG_EVM_PRIVATE_KEY: "0x1234" }), /32-byte hex/);
  assert.throws(() => settingsFromEnv({ TRONENERGYFROG_MAX_PAYMENT_USD: "-1" }), /positive dollar/);
  const configured = settingsFromEnv({
    TRONENERGYFROG_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    TRONENERGYFROG_MAX_PAYMENT_USD: "2.5",
  });
  assert.equal(configured.maxPaymentUsd, "$2.5");
  assert.equal(typeof configured.payingFetch, "function");
  assert.equal(settingsFromEnv({}).payingFetch, undefined);
});
