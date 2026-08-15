# SPX Weekly Put Credit Spread — Execution Prompt

> **Run guard:** Only execute on the **first trading day of the week** at ~10:00 ET.
> Check: *"Was yesterday's session in the same calendar week? If yes, abort."*
> If today is not the first trading day or time is outside 09:45–11:00 ET, abort.

---

### Step 0 — Inputs (fill in manually each week)

| Parameter | Source |
|---|---|
| `PRIOR_WEEKLY_CLOSE` | SPX close of the prior week's last trading session from the *completed* weekly bar |
| `WEEKLY_ATR14` | Wilder ATR(14) on **weekly** OHLC — Saty indicator as of Friday's close. **NEVER hardcode 2.74%.** Zero look-ahead. |
| `SPOT_TODAY_10AM` | Current SPX price at execution time |
| `COMMISSION` | $2.64 per spread |

---

### Step 1 — Compute strikes from real ATR

```python
SHORT_STRIKE = round(PRIOR_WEEKLY_CLOSE − 1 × WEEKLY_ATR14, nearest 5)
LONG_STRIKE  = SHORT_STRIKE − 50
ATR_PCT      = (WEEKLY_ATR14 / PRIOR_WEEKLY_CLOSE) × 100
```

**Anchor discipline:** The level is fixed at **Friday's close minus one ATR**. Monday gaps do NOT move it. If SPX gapped down, your strike is further ITM — that's the point.

---

### Step 2 — Fetch the real chain

1. `etrade_account` → `"optionexpiry"`, symbol `"SPX"` → find the week's **last trading session** (usually Friday, Thursday for Good Friday weeks).
2. `etrade_account` → `"optionchains"`, symbol `"SPX"` (verify weekly expiry resolves under root SPX), chainType `"PUT"`, with correct expiry date. Fetch the **full chain**.
3. **Use ONLY returned data. Do not fabricate IV, bid, ask, delta, theta, volume, or OI.**

---

### Step 3 — Display strikes from `LONG_STRIKE − 15` to `PRIOR_WEEKLY_CLOSE + 5`

Show: `Strike | % Below Friday Close | IV | Bid | Ask | Delta | Theta | Bid Size | OI`

- Label `SHORT_STRIKE` as **"−1 ATR (Saty)"**, `LONG_STRIKE` as **"Wing (−50)"**.
- **Do NOT use "−0.5 ATR"** — not a Saty rail. Saty rails: ±23.6%, ±61.8%, ±100% of ATR.
- **Liquidity gate:** Skip only if bid size < 10 at the short strike, OI < 100 on either leg, or the quote is one-sided/crossed. Do NOT skip based on Monday AM traded volume alone.

---

### Step 4 — Credit spread evaluation (CREDIT trade)

The strategy **sells** the −1 ATR put and **buys** a wing 50 below.

```python
RAW_CREDIT_PTS     = SHORT_STRIKE_BID − LONG_STRIKE_ASK          # in points (e.g. 2.98)
COMMISSION_PTS     = 0.0264                                       # $2.64 ÷ 100
NET_CREDIT_PTS     = RAW_CREDIT_PTS − COMMISSION_PTS             # keep units in points
NET_CREDIT_USD     = NET_CREDIT_PTS × 100                        # dollars
MAX_RISK_PTS       = 50 − RAW_CREDIT_PTS                         # raw credit — commissions don't move settlement
MAX_RISK_DOLLARS   = MAX_RISK_PTS × 100
RETURN_IF_EXPIRED  = (NET_CREDIT_PTS / MAX_RISK_PTS) × 100       # both in points — units consistent
BREAKEVEN          = SHORT_STRIKE − RAW_CREDIT_PTS               # raw credit is correct for breakeven (settlement math ignores commissions)
```

**Skip if NET_CREDIT_PTS ≤ 0.**

**Pricing:** Net mid = (short strike mid − long strike mid). Enter as a single spread limit order at **net mid**, rounded to $0.05. Step toward natural credit in **$0.05 decrements** if unfilled after ~30–60 seconds. **Never use market orders.**

*Note on Delta:* Delta proxies the probability of **settling** ITM on Friday. SPXW is European and cash-settled — there is no assignment, ever.

---

### Step 5 — Sizing

- Size to **structural max loss ~$5,000/lot** (50pt × 100), never to observed drawdown.
- Expect 2–3 losing weeks/year, occasionally at full width.
- *Caveat: Author hasn't deployed this — research candidate. First job is generating paper trades.*

---

### Step 6 — Render

Output the full chain data in an applet with:
- The computed strike targets highlighted
- Real data only — no interpolated strikes, no fabricated Greeks
- Credit spread P&L diagram (net credit, max loss, breakeven)

**Post-fill log:** After the order fills, recompute breakeven and returns from the **actual fill price** (not the pre-trade mid/natural estimates) so the paper-trade log matches reality.

---

**Anti-drift Checklist:**
- [x] Anchor = Friday close
- [x] ATR = live, completed bar (not 2.74%)
- [x] Direction = CREDIT spread (sell short, buy wing)
- [x] Net credit after commission ($2.64)
- [x] Limit order at mid, $0.05 steps, no market orders
- [x] Expiry = last trading session (not hardcoded Friday)
- [x] Timing = first trading day ~10:00 ET (not hardcoded Monday)
- [x] Liquidity = bid size + OI (not traded volume)
- [x] Saty rails = ±23.6/61.8/100% (not −0.5 ATR)
- [x] Cash-settled European (no assignment language)
- [x] Sizing = $5k structural max loss
