import {
  createPublicClient, createWalletClient, custom, http, defineChain, parseUnits, formatUnits,
  keccak256, toHex, isAddress, getAddress, parseGwei, decodeEventLog,
} from 'https://esm.sh/viem@2.56.8';
import { STAGEPAY_ABI, ERC20_ABI } from './abi.js';
import * as config from './config.js';

// Local testing against `arc-anvil --network arc`: only on localhost, never on the public site.
const params = new URLSearchParams(location.search);
const DEV = ['localhost', '127.0.0.1'].includes(location.hostname) && params.has('dev');
const CONTRACT = DEV ? params.get('contract') : config.CONTRACT;
const DEPLOY_BLOCK = DEV ? 0 : config.DEPLOY_BLOCK;

const arc = defineChain({
  id: DEV ? 31337 : 5042,
  name: DEV ? 'Arc (local)' : 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [DEV ? 'http://127.0.0.1:8547' : 'https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
});
const EXPLORER = arc.blockExplorers.default.url;
const TOKENS = {
  USDC: { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
  EURC: { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 },
};
const STATUS = ['None', 'Funded', 'Submitted', 'Released', 'Refunded', 'Split'];
const MIN_FEE = parseGwei('25'); // Arc drops transactions below the 20 gwei base-fee floor

const pub = createPublicClient({ chain: arc, transport: http() });
let wallet = null;
let account = null;
let currentJob = null;

const $ = (id) => document.getElementById(id);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const addrLink = (a) => `<a href="${EXPLORER}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>`;
const txLink = (h) => `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener">${h.slice(0, 10)}…</a>`;
const tokenOf = (addr) => Object.entries(TOKENS).find(([, t]) => t.address.toLowerCase() === addr.toLowerCase());
const fmtTime = (s) => new Date(Number(s) * 1000).toLocaleString();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(html, ms = 5000) {
  const t = $('toast');
  t.innerHTML = html;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ wallet

async function connect() {
  if (!window.ethereum) return toast('No browser wallet found. Install MetaMask, Rabby or similar.');
  wallet = createWalletClient({ chain: arc, transport: custom(window.ethereum) });
  [account] = await wallet.requestAddresses();
  await ensureArc();
  $('connect').textContent = short(account);
  window.ethereum.on?.('accountsChanged', ([a]) => { account = a; $('connect').textContent = a ? short(a) : 'Connect wallet'; if (currentJob) loadJob(currentJob); });
  window.ethereum.on?.('chainChanged', () => updateNet());
  updateNet();
  if (currentJob) loadJob(currentJob);
}

async function ensureArc() {
  const chainId = await wallet.getChainId();
  if (chainId === arc.id) return;
  try {
    await wallet.switchChain({ id: arc.id });
  } catch {
    await wallet.addChain({ chain: arc });
  }
}

async function updateNet() {
  const n = $('net');
  if (!wallet) return;
  const id = await wallet.getChainId();
  n.textContent = id === arc.id ? (DEV ? 'Arc local (dev)' : 'Arc mainnet') : `Wrong network (${id})`;
  n.className = `pill ${id === arc.id ? 'ok' : 'bad'}`;
}

async function send(fn, args, label) {
  if (!wallet) await connect();
  if (!account) return null;
  await ensureArc();
  const fees = await pub.estimateFeesPerGas().catch(() => ({}));
  const maxFeePerGas = (fees.maxFeePerGas ?? 0n) > MIN_FEE ? fees.maxFeePerGas : MIN_FEE;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? parseGwei('1');
  toast(`${label}: confirm in your wallet…`, 60000);
  const hash = await wallet.writeContract({ ...fn, args, account, maxFeePerGas, maxPriorityFeePerGas });
  toast(`${label}: sent ${txLink(hash)}`, 60000);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted`);
  toast(`${label}: confirmed ${txLink(hash)}`);
  return receipt;
}

const stagepay = (functionName) => ({ address: CONTRACT, abi: STAGEPAY_ABI, functionName });

// --------------------------------------------------------------- open job

async function loadJob(id) {
  currentJob = id;
  const box = $('job');
  box.innerHTML = '<p class="muted">Loading…</p>';
  const qs = new URLSearchParams(location.search);
  qs.set('job', id);
  history.replaceState(null, '', `?${qs}`);
  try {
    const [client, freelancer, token, reviewPeriod, termsHash, total, settled] =
      await pub.readContract({ ...stagepay('jobs'), args: [BigInt(id)] });
    if (client === '0x0000000000000000000000000000000000000000') {
      box.innerHTML = `<p class="muted">Job #${esc(id)} does not exist.</p>`;
      return;
    }
    const ms = await pub.readContract({ ...stagepay('getMilestones'), args: [BigInt(id)] });
    const block = await pub.getBlock({ blockTag: 'latest' });
    const now = Number(block.timestamp);
    const [sym, tok] = tokenOf(token) ?? ['tokens', { decimals: 6 }];
    const amt = (v) => `${formatUnits(v, tok.decimals)} ${sym}`;
    const me = account?.toLowerCase();
    const isClient = me === client.toLowerCase();
    const isFreelancer = me === freelancer.toLowerCase();
    const role = isClient ? 'You are the client' : isFreelancer ? 'You are the freelancer' : account ? 'Viewing as a third party' : 'Connect a wallet to act';

    const rows = ms.map((m, i) => {
      const st = STATUS[m.status];
      const open = st === 'Funded' || st === 'Submitted';
      const claimAt = Number(m.submittedAt) + Number(reviewPeriod);
      const a = [];
      if (isFreelancer && st === 'Funded') a.push(btn('submit', i, 'Submit work', 'primary'));
      if (isFreelancer && st === 'Submitted') {
        a.push(now >= claimAt ? btn('claim', i, 'Claim payment', 'primary') : `<span class="muted">Claimable ${fmtTime(claimAt)}</span>`);
      }
      if (isClient && st === 'Submitted') {
        a.push(btn('approve', i, 'Approve & pay', 'primary'));
        if (now < claimAt && m.revisions < 3) a.push(btn('revise', i, `Request revision (${3 - m.revisions} left)`));
      }
      if (isClient && st === 'Funded' && now > Number(m.deadline)) a.push(btn('cancel', i, 'Reclaim (deadline passed)'));
      if ((isClient || isFreelancer) && open) {
        const pending = m.splitProposer !== '0x0000000000000000000000000000000000000000';
        if (pending && m.splitProposer.toLowerCase() !== me) {
          a.push(btn('acceptSplit', i, `Accept split: ${amt(m.splitToFreelancer)} to freelancer`, 'primary', m.splitToFreelancer));
        }
        a.push(btn('proposeSplit', i, pending ? 'New split proposal' : 'Propose split'));
      }
      if (isFreelancer && open) a.push(btn('refund', i, 'Refund client'));
      const split = m.splitProposer !== '0x0000000000000000000000000000000000000000'
        ? `<span class="muted">Split proposed by ${m.splitProposer.toLowerCase() === client.toLowerCase() ? 'client' : 'freelancer'}: ${amt(m.splitToFreelancer)} to freelancer, rest to client</span>` : '';
      return `<div class="ms">
        <div class="ms-head"><b>Milestone ${i + 1} · ${amt(m.amount)}</b><span class="status ${st}">${st}</span></div>
        <span class="muted">Deadline ${fmtTime(m.deadline)}${m.revisions ? ` · ${m.revisions} revision(s)` : ''}${st === 'Submitted' ? ` · review ends ${fmtTime(claimAt)}` : ''}</span>
        ${split}
        <div class="actions">${a.join('')}</div>
      </div>`;
    }).join('');

    box.innerHTML = `<div class="card">
      <div class="facts">
        <div><span>Job</span><b>#${esc(id)}</b></div>
        <div><span>Client</span><b>${addrLink(client)}</b></div>
        <div><span>Freelancer</span><b>${addrLink(freelancer)}</b></div>
        <div><span>Escrowed</span><b>${amt(total)}</b></div>
        <div><span>Settled</span><b>${amt(settled)}</b></div>
        <div><span>Review window</span><b>${(Number(reviewPeriod) / 86400).toFixed(2).replace(/\.00$/, '')} days</b></div>
      </div>
      <p class="muted">${role}. Agreement hash <code title="${termsHash}">${termsHash.slice(0, 18)}…</code>
        <button class="btn small ghost" id="verify-terms">Verify agreement text</button></p>
      ${rows}
      <div class="log" id="log"></div>
    </div>`;
    $('verify-terms').onclick = () => {
      const text = prompt('Paste the agreement text to check it against the on-chain hash:');
      if (text == null) return;
      toast(keccak256(toHex(text)) === termsHash ? 'Match: this is the agreed text.' : 'No match: this text differs from what was agreed.');
    };
    box.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => act(b.dataset.act, Number(b.dataset.i), b.dataset.v, tok); });
    loadLog(id);
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not load job: ${esc(e.shortMessage || e.message)}</p>`;
  }
}

function btn(act, i, label, kind = '', value = '') {
  return `<button class="btn small ${kind}" data-act="${act}" data-i="${i}" data-v="${value}">${label}</button>`;
}

async function act(kind, i, value, tok) {
  const id = BigInt(currentJob);
  const idx = BigInt(i);
  try {
    if (kind === 'submit') {
      const note = prompt('Delivery note (link to the work, what changed):', '');
      if (note == null) return;
      await send(stagepay('submit'), [id, idx, note], 'Submit');
    } else if (kind === 'claim') await send(stagepay('claim'), [id, idx], 'Claim');
    else if (kind === 'approve') await send(stagepay('approve'), [id, idx], 'Approve');
    else if (kind === 'revise') {
      const note = prompt('What needs to change?', '');
      if (note == null) return;
      await send(stagepay('requestRevision'), [id, idx, note], 'Request revision');
    } else if (kind === 'cancel') await send(stagepay('cancelExpired'), [id, idx], 'Reclaim');
    else if (kind === 'refund') {
      if (!confirm('Return this milestone\'s funds to the client?')) return;
      await send(stagepay('refundByFreelancer'), [id, idx], 'Refund');
    } else if (kind === 'proposeSplit') {
      const v = prompt('Amount that should go to the freelancer (the rest returns to the client):', '');
      if (v == null || !v.trim() || Number.isNaN(Number(v))) return v == null ? undefined : toast('Enter an amount, e.g. 12.5');
      await send(stagepay('proposeSplit'), [id, idx, parseUnits(v, tok.decimals)], 'Propose split');
    } else if (kind === 'acceptSplit') await send(stagepay('acceptSplit'), [id, idx, BigInt(value)], 'Accept split');
    await loadJob(currentJob);
  } catch (e) {
    toast(`Failed: ${esc(e.shortMessage || e.message)}`, 8000);
  }
}

async function loadLog(id) {
  const el = $('log');
  if (!el) return;
  try {
    const latest = await pub.getBlockNumber({ cacheTime: 0 });
    const topic = toHex(BigInt(id), { size: 32 });
    const logs = [];
    const STEP = 9_000n;
    for (let from = BigInt(DEPLOY_BLOCK); from <= latest && logs.length < 200; from += STEP + 1n) {
      const to = from + STEP > latest ? latest : from + STEP;
      const chunk = await pub.request({
        method: 'eth_getLogs',
        params: [{ address: CONTRACT, fromBlock: toHex(from), toBlock: toHex(to), topics: [null, topic] }],
      });
      logs.push(...chunk);
      if (latest - BigInt(DEPLOY_BLOCK) > 600_000n) break; // keep the page light; older history is on the explorer
    }
    if (!logs.length) return;
    el.innerHTML = '<b>History</b>' + logs.map((l) => {
      let name = 'event';
      try { name = decodeEventLog({ abi: STAGEPAY_ABI, data: l.data, topics: l.topics }).eventName; } catch {}
      return `<span>${name} · ${txLink(l.transactionHash)}</span>`;
    }).join('');
  } catch {
    el.innerHTML = `<span>History: see the <a href="${EXPLORER}/address/${CONTRACT}" target="_blank" rel="noopener">contract on the explorer</a>.</span>`;
  }
}

// ------------------------------------------------------------- create job

function addMilestoneRow(amount = '', days = 7) {
  const d = new Date(Date.now() + days * 86400000);
  const row = document.createElement('div');
  row.className = 'ms-row';
  row.innerHTML = `<input placeholder="Milestone (for your records)">
    <input type="number" min="0.000001" step="0.000001" placeholder="Amount" value="${amount}" required>
    <input type="date" value="${d.toISOString().slice(0, 10)}" required title="Submission deadline">
    <button type="button" class="btn small ghost" aria-label="Remove">✕</button>`;
  row.querySelector('button').onclick = () => { if ($('c-milestones').children.length > 1) { row.remove(); summarize(); } };
  row.querySelectorAll('input').forEach((i) => { i.oninput = summarize; });
  $('c-milestones').appendChild(row);
  summarize();
}

function readCreateForm() {
  const sym = $('c-token').value;
  const tok = TOKENS[sym];
  const rows = [...$('c-milestones').children].map((r) => r.querySelectorAll('input'));
  const amounts = rows.map(([, a]) => parseUnits(a.value || '0', tok.decimals));
  const deadlines = rows.map(([, , d]) => BigInt(Math.floor(new Date(`${d.value}T23:59:59`).getTime() / 1000)));
  const total = amounts.reduce((s, a) => s + a, 0n);
  return { sym, tok, amounts, deadlines, total };
}

function summarize() {
  try {
    const { sym, tok, amounts, total } = readCreateForm();
    $('c-summary').textContent = `${amounts.length} milestone(s), ${formatUnits(total, tok.decimals)} ${sym} will be locked in escrow. Network fees are paid in USDC (about a cent each).`;
  } catch { $('c-summary').textContent = ''; }
}

async function createJob(ev) {
  ev.preventDefault();
  const fl = $('c-freelancer').value.trim();
  if (!isAddress(fl)) return toast('Enter a valid freelancer address.');
  const { tok, amounts, deadlines, total } = readCreateForm();
  if (amounts.some((a) => a === 0n)) return toast('Every milestone needs an amount.');
  const review = BigInt(Math.round(Number($('c-review').value) * 86400));
  const terms = $('c-terms').value.trim();
  const termsHash = terms ? keccak256(toHex(terms)) : `0x${'0'.repeat(64)}`;
  $('c-submit').disabled = true;
  try {
    if (!wallet) await connect();
    const allowance = await pub.readContract({ address: tok.address, abi: ERC20_ABI, functionName: 'allowance', args: [account, CONTRACT] });
    if (allowance < total) {
      await send({ address: tok.address, abi: ERC20_ABI, functionName: 'approve' }, [CONTRACT, total], 'Approve');
    }
    const receipt = await send(stagepay('createJob'), [getAddress(fl), tok.address, amounts, deadlines, review, termsHash], 'Create job');
    const created = receipt.logs.map((l) => { try { return decodeEventLog({ abi: STAGEPAY_ABI, data: l.data, topics: l.topics }); } catch { return null; } })
      .find((e) => e?.eventName === 'JobCreated');
    const id = created ? created.args.jobId.toString() : '?';
    const qs = new URLSearchParams(location.search);
    qs.set('job', id);
    const url = `${location.origin}${location.pathname}?${qs}`;
    $('create-result').innerHTML = `<div class="card"><b>Job #${id} is funded.</b>
      <p>Send this link to the freelancer: <a href="${url}">${url}</a></p>
      ${terms ? '<p class="muted">Keep a copy of the agreement text; anyone can check it against the on-chain hash.</p>' : ''}</div>`;
  } catch (e) {
    toast(`Failed: ${esc(e.shortMessage || e.message)}`, 8000);
  } finally {
    $('c-submit').disabled = false;
  }
}

// ------------------------------------------------------------------- boot

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-open').hidden = name !== 'open';
  $('tab-create').hidden = name !== 'create';
}

document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
$('connect').onclick = () => connect().catch((e) => toast(esc(e.shortMessage || e.message)));
$('open-form').onsubmit = (e) => { e.preventDefault(); loadJob($('job-id').value); };
$('create-form').onsubmit = createJob;
$('c-add').onclick = () => addMilestoneRow('', 7 * ($('c-milestones').children.length + 1));
$('c-token').onchange = summarize;
$('contract-link').href = `${EXPLORER}/address/${CONTRACT}`;
$('contract-link').textContent = short(CONTRACT);
addMilestoneRow('', 7);
addMilestoneRow('', 14);

if (DEV) $('net').textContent = 'Arc local (dev)';
const q = params.get('job');
if (q) { $('job-id').value = q; loadJob(q); }
