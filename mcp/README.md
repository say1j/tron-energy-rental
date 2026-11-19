# TronEnergyFrog MCP server

<!-- mcp-name: io.github.say1j/tronenergyfrog -->

An [MCP](https://modelcontextprotocol.io) server that lets AI agents check live TRON Energy prices and rent Energy, so USDT TRC-20 transfers stop burning TRX.

- **No account needed:** live prices and x402 quotes work without a key. Agents can pay in USDC on Base.
- **With an account:** add your TronEnergyFrog API key to pay from your TRX balance, check a recipient's USDT state, and track orders.

Energy always goes to the wallet that **sends** the USDT. As a rule of thumb, 65,000 Energy covers a transfer to a wallet that already holds USDT. Use 130,000 when the recipient holds none.

## Tools

| Tool | Needs | What it does |
|---|---|---|
| `get_energy_prices` | nothing | Live prices for 65K and 130K Energy, for 1 hour or 1 day, with the TRX burn they replace and a USD reference |
| `create_x402_quote` | nothing | Locks a price for 10 minutes; payable with x402 USDC (free to create) |
| `get_x402_rental` | nothing | Payment and delivery status of a quote |
| `pay_x402_quote` | `TRONENERGYFROG_EVM_PRIVATE_KEY` | Pays a quote with USDC on Base, capped per payment |
| `get_account` | `TRONENERGYFROG_API_KEY` | Balance, discount and key status |
| `check_transfer_energy` | `TRONENERGYFROG_API_KEY` | Whether a USDT recipient holds USDT, and the Energy and TRX burn for sending to it |
| `rent_energy` | `TRONENERGYFROG_API_KEY` | Rents Energy from your TRX balance, with a retry-safe idempotency key |
| `get_rental` | `TRONENERGYFROG_API_KEY` | Status of an account rental |

Tools that spend money are marked `destructiveHint` and ask the agent to confirm the address, amount and price with you first.

## Install

Add this to your MCP client's configuration (Claude Desktop, Claude Code, Cursor, Windsurf and others use this format):

```json
{
  "mcpServers": {
    "tronenergyfrog": {
      "command": "npx",
      "args": ["-y", "tronenergyfrog-mcp"],
      "env": {
        "TRONENERGYFROG_API_KEY": "optional-account-api-key"
      }
    }
  }
}
```

Claude Code:

```sh
claude mcp add tronenergyfrog -- npx -y tronenergyfrog-mcp
```

## Configuration

All settings are optional.

| Variable | Purpose |
|---|---|
| `TRONENERGYFROG_API_KEY` | Account API key. Get it from [@tron_energy_frog_bot](https://t.me/tron_energy_frog_bot) → **Account → Generate API key**. Enables the account tools. |
| `TRONENERGYFROG_EVM_PRIVATE_KEY` | `0x`-prefixed key of a Base wallet that pays x402 quotes in USDC. Enables `pay_x402_quote`. Use a dedicated wallet holding only what you are willing to spend. |
| `TRONENERGYFROG_MAX_PAYMENT_USD` | Largest single x402 payment, in USD. Default `5`. Larger payments are refused before signing. |
| `TRONENERGYFROG_API_URL` | API origin. Default `https://api.tronenergyfrog.com`. |

Your keys stay on your machine: the server sends the API key only to the TronEnergyFrog API, and the wallet key never leaves the process. Only USDC payment authorizations are signed with it.

## How x402 rental works

1. `create_x402_quote` locks the Energy price and the TRX/USD rate for 10 minutes.
2. `pay_x402_quote` (or any x402 v2 client) pays the quote's URL with USDC on Base or Solana.
3. `get_x402_rental` reports `settling`, `fulfillment_pending`, then `succeeded` once the Energy is delegated.

API reference: <https://api.tronenergyfrog.com/v1/docs> · x402 details: <https://tronenergyfrog.com/x402>

## License

MIT
