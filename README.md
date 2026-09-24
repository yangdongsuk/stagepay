# Stagepay

Milestone escrow for freelance work, settled in **USDC or EURC on Arc**.

A client locks the whole job up front. Each milestone is paid when the client approves it. If the client goes quiet past the review window, the freelancer claims the payment. There is no platform in the middle, no owner key, no fee and no upgrade path.

**Live app:** https://yangdongsuk.github.io/stagepay/ · **Contract:** see [Deployment](#deployment)

## Why

Freelancers on marketplaces wait days for payouts and give up 10–20% in fees. Paying them directly means someone has to trust someone: the client pays and hopes the work arrives, or the freelancer works and hopes the invoice gets paid.

Stagepay fixes the order of trust with code:

| Rule | Who it protects |
| --- | --- |
| The whole job is funded before work starts | Freelancer: the money is visibly there |
| No response within the review window → freelancer can claim | Freelancer: finished work can't be held hostage |
| At most 3 revision requests per milestone | Freelancer: review can't be used to stall forever |
| An unsubmitted milestone can be reclaimed after its deadline | Client: no paying for work that never shows up |
| Either side proposes a split, the other accepts | Both: disputes settle without an arbiter |
| Only a hash of the agreement goes on chain | Both: private terms, verifiable later |

## Why Arc

- **Fees are paid in USDC.** A freelancer who only ever holds dollars can use this. There is no second token to buy just to press "Claim".
- **Sub-second deterministic finality.** "Approve & pay" means paid, not "wait for confirmations".
- **Circle stablecoins are native.** USDC and EURC both work, so the same escrow covers dollar and euro contracts.

## How it works

```
client  ── approve(USDC) ──► createJob(freelancer, token, amounts[], deadlines[], reviewPeriod, termsHash)
                                   │  pulls the full total into escrow
freelancer ── submit(i, note) ─────┤  starts the review window
client  ── approve(i) ─────────────┤  → pays milestone i
client  ── requestRevision(i) ─────┤  → back to Funded (max 3×, deadline extended)
freelancer ── claim(i) ────────────┤  → pays milestone i after review window with no response
client  ── cancelExpired(i) ───────┤  → refunds an unsubmitted milestone after its deadline
freelancer ── refundByFreelancer(i)┤  → voluntary refund
either  ── proposeSplit / acceptSplit(i, x) → x to freelancer, rest to client
```

Milestone states: `Funded → Submitted → Released | Refunded | Split`.

## Arc-specific details handled

- USDC is used through its **ERC-20 interface** at `0x3600…0000` (6 decimals). The contract never touches native value, so the 18-decimal native balance and Arc's native-transfer rules (zero-address and blocklist reverts) don't apply to escrow accounting.
- Deposits are checked by balance delta, so a fee-on-transfer token can't leave a job under-collateralised.
- The app sets `maxFeePerGas` to at least 25 gwei. Arc's mempool silently drops transactions below its 20 gwei floor.
- Deadlines and review windows are days long, so second-level timestamp granularity (Arc blocks can share a timestamp) doesn't matter.

## Develop

```bash
forge test            # 15 tests, including a 2,000-run fuzz test that all funds end up with client or freelancer
cd app && python3 -m http.server 8000   # static app, no build step
```

## Deployment

| Network | Address |
| --- | --- |
| Arc mainnet (5042) | _pending_ |

## Limitations

- No arbiter. If the parties can't agree on a split, a submitted milestone pays out after the review window; an unsubmitted one refunds after its deadline.
- Unaudited. Keep amounts small.
- The agreement text is off-chain. Keep a copy; the app can check any text against the on-chain hash.

MIT licensed.
