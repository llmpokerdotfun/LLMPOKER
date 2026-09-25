/**
 * On-chain agent-action recording (FR-10.4 companion).
 *
 * `Poker.recordAction` makes the ordered sequence of wagered actions public and attributable:
 * the operator relays each action together with the agent's own EIP-712 signature, and the
 * contract verifies that the recovered wallet is the wallet occupying the seat. The point of this
 * file is *cross-language compatibility* — the digest is built here exactly as
 * `packages/server/src/app.ts` builds it (same domain, same `AGENT_ACTION_TYPES` field list and
 * order, `uint8` un-normalised, string fields hashed as `keccak256(utf8)`) and then signed with
 * `ethers`, so a type string or field-order divergence between the contract and the server fails
 * here instead of silently accepting nothing in production.
 *
 * The contract deliberately does NOT reimplement betting legality — see the NatSpec on
 * `recordAction`. These tests therefore assert *recording and attribution*, never rule checks.
 */

import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { commitHiddenDeck, createWagerTable, snapshotFixture, type PokerStack, type SnapshotFixture } from './support/helpers';

/**
 * The preset table created by `createWagerTable`, in both of the forms the two sides use.
 *
 * `TABLE_TEXT` is what the server signs and what the fixture creates the table with; `TABLE_ID` is
 * `keccak256(utf8(TABLE_TEXT))`, the `bytes32` the contract is called with (the server's `id32`).
 * Deriving it that way rather than with `ethers.encodeBytes32String` matters: the latter
 * left-aligns the ASCII bytes, which is a *different* value, and a test that used it would be
 * checking a table the contract never sees.
 */
const TABLE_TEXT = 'low-1';
const TABLE_ID = ethers.id(TABLE_TEXT);
const LEGAL_BUY_IN = ethers.parseEther('20');

/**
 * The `AgentAction` type exactly as `AGENT_ACTION_TYPES` in `packages/shared/src/eip712.ts`
 * declares it. Kept as text (not as `ethers.TypedDataEncoder.hashStruct` input) because the
 * typehash is `keccak256` of the *type string* and that string is the thing under test.
 */
const ACTION_TYPE_STRING =
  'AgentAction(string agentId,string tableId,string handId,uint8 seat,uint8 action,uint256 amount,uint256 nonce,uint256 deadline)';

/** Action enum order, part of the signed payload (`ACTION_ENUM` in the shared package). */
const ACTION = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALL_IN: 5 } as const;

/** The EIP-712 domain the server signs in (`eip712Domain` in `packages/server/src/auth.ts`). */
function domainFor(pokerAddress: string, chainId: number) {
  return { name: 'LLM Poker Arena', version: '1', chainId, verifyingContract: pokerAddress };
}

/**
 * The typed-data `types` block, mirroring `AGENT_ACTION_TYPES` field-for-field. `uint8` is
 * intentionally not widened to `uint256`: EIP-712 hashes the declared type verbatim.
 */
const ACTION_TYPES = {
  AgentAction: [
    { name: 'agentId', type: 'string' },
    { name: 'tableId', type: 'string' },
    { name: 'handId', type: 'string' },
    { name: 'seat', type: 'uint8' },
    { name: 'action', type: 'uint8' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/**
 * Sign exactly as the server does, and derive the digest the contract will rebuild.
 *
 * The subtlety this file exists to pin down: on the wire the `agentId`, `tableId` and `handId`
 * fields are **strings**, and EIP-712 hashes a `string` field as `keccak256(utf8 bytes)` *while*
 * encoding the struct. The contract receives `tableId`/`handId` already hashed to `bytes32` (that
 * is what it keys storage on) and re-hashes `agentId` itself, so both sides land on the same three
 * words — but only if the test signs the *strings*. Signing pre-hashed values would make
 * `ethers` hash them a second time, and the recovered signer would be an address nobody controls.
 */
async function signWith(
  wallet: ethers.HDWallet | ethers.Wallet,
  domain: { name: string; version: string; chainId: number; verifyingContract: string },
  message: Record<string, unknown>,
): Promise<string> {
  const signer = wallet as unknown as { signTypedData: (...args: unknown[]) => Promise<string> };
  return signer.signTypedData(domain, ACTION_TYPES, message);
}

/** The `AgentAction` message body exactly as the server passes it to `verifySignature`. */
function actionMessage(input: {
  agentId: string;
  tableId: string;
  handId: string;
  seat: number;
  action: number;
  amount?: bigint;
  nonce: bigint;
  deadline: bigint;
}): Record<string, unknown> {
  return {
    agentId: input.agentId,
    tableId: input.tableId,
    handId: input.handId,
    seat: input.seat,
    action: input.action,
    // `shape.action.amount ?? 0n` in the act handler: only BET/RAISE ever carry a value.
    amount: input.amount ?? 0n,
    nonce: input.nonce,
    deadline: input.deadline,
  };
}

/**
 * The digest `Poker._recoverActionSigner` rebuilds, recomputed independently from `ethers`.
 *
 * This is the load-bearing cross-language check. `ethers.signTypedData` and the contract are two
 * implementations of the same spec, and the only thing that ties them together is this arithmetic:
 * `keccak256(0x1901 ‖ domainSeparator ‖ keccak256(typehash ‖ agentId ‖ tableId ‖ handId ‖ seat ‖
 * action ‖ amount ‖ nonce ‖ deadline))`, all words `abi.encode`d to 32 bytes. Deriving it here (not
 * pasting a literal) means a moved field, a widened `uint8` or a renamed type fails loudly.
 */
function contractDigest(input: {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  tableText: string;
  handText: string;
  agentId: string;
  seat: number;
  action: number;
  amount?: bigint;
  nonce: bigint;
  deadline: bigint;
}): string {
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint8', 'uint8', 'uint256', 'uint256', 'uint256'],
      [
        ethers.keccak256(ethers.toUtf8Bytes(ACTION_TYPE_STRING)),
        // The contract hashes the agentId string itself: `keccak256(bytes(agentId))`.
        ethers.keccak256(ethers.toUtf8Bytes(input.agentId)),
        ethers.id(input.tableText),
        ethers.id(input.handText),
        input.seat,
        input.action,
        input.amount ?? 0n,
        input.nonce,
        input.deadline,
      ],
    ),
  );
  return ethers.keccak256(
    ethers.concat([new Uint8Array([0x19, 0x01]), ethers.TypedDataEncoder.hashDomain(input.domain), structHash]),
  );
}

async function signAction(input: {
  wallet: ethers.HDWallet | ethers.Wallet;
  chainId: number;
  pokerAddress: string;
  agentId: string;
  tableId: string;
  handId: string;
  seat: number;
  action: number;
  amount?: bigint;
  nonce: bigint;
  deadline: bigint;
}): Promise<{ signature: string; message: Record<string, unknown> }> {
  const message = actionMessage(input);
  const signature = await signWith(input.wallet, domainFor(input.pokerAddress, input.chainId), message);
  return { signature, message };
}

/** Hopelessly-future deadline for the cases that are not about expiry. */
const FAR_FUTURE = 4_000_000_000n;

describe('Poker action recording (EIP-712 relay)', () => {
  let fixture: SnapshotFixture;
  let stack: PokerStack;
  let poker: any;
  /** Seat 0's occupant: a real signer, so the seat holds a wallet the test controls. */
  let occupant: ethers.Wallet;
  let agentId: string;
  let tableIdText: string;
  let chainId: number;
  let pokerAddress: string;
  /**
   * One nonce sequence shared by every hand in this file. Contract nonces are per `(handId, seat)`,
   * so hands cannot collide; one sequence just keeps the numbers easy to read. It starts well above
   * zero deliberately — nonce 0 is never "greater than" an unseen nonce of 0, so it is reserved for
   * the test that asserts an action starting from the initial state is rejected.
   */
  let nonceSeq = 1_000n;
  const nextNonce = (): bigint => ++nonceSeq;

  before(async () => {
    // The occupant is a wallet this file holds the key for (it signs the actions), so it cannot be
    // one of Hardhat's funded signers.
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    poker = stack.poker;
    agentId = 'agent_ab12cd34ef56';
    tableIdText = TABLE_TEXT;
    chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    pokerAddress = stack.pokerAddress;
    const provider = new ethers.BrowserProvider(hre.network.provider as never, undefined, { cacheTimeout: -1 });
    occupant = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), provider);
  });

  /**
   * Give the occupant its ETH, tokens and Poker allowance.
   *
   * Called from `beforeEach` **after** `reset()`: the snapshot predates the funding, so a rewind
   * would otherwise take it all back (and reset the node's nonce for the account, which is what
   * keeps the client-side wallet's next transaction at nonce 0). `cacheTimeout: -1` on the
   * provider disables ethers' response cache, without which a cached `eth_getTransactionCount`
   * makes the *next* transaction rebuild itself on a nonce already spent inside the cache window.
   */
  async function fundOccupant(): Promise<void> {
    const hh = hre as unknown as { ethers: { provider: { send: (m: string, p: unknown[]) => Promise<unknown> } } };
    await hh.ethers.provider.send('hardhat_setBalance', [
      await occupant.getAddress(),
      `0x${ethers.parseEther('100').toString(16)}`,
    ]);
    const token = stack.token as ethers.Contract;
    // Generous on purpose: the occupant funds several seats (3 at the main table plus 1 at the
    // second table the tamper test opens), and the table's own buy-in cap applies per seat, not to
    // the wallet, so a single top-up has to cover all of them.
    await (await token.connect(stack.owner) as ethers.Contract).transfer(
      await occupant.getAddress(),
      ethers.parseEther('100'),
    );
    await (await token.connect(occupant) as ethers.Contract).approve(stack.pokerAddress, ethers.MaxUint256);
  }

  beforeEach(async () => {
    await fixture.reset();
    await createWagerTable(stack);
    await fundOccupant();
  });

  /** Seat the signing wallet at seat 0 and two more funded seats, ready for one or two hands. */
  async function seatSigner(): Promise<void> {
    await (poker.connect(occupant) as ethers.Contract).deposit(TABLE_ID, 0, LEGAL_BUY_IN);
    const second = stack.players[1];
    if (!second) throw new Error('the fixture must expose at least two player signers');
    await (poker.connect(second) as ethers.Contract).deposit(TABLE_ID, 1, LEGAL_BUY_IN);
    // Seat 2 exists so a test can have a second hand open while the first one holds seats 0 and 1.
    const third = stack.players[2];
    if (!third) throw new Error('the fixture must expose at least three player signers');
    await (poker.connect(third) as ethers.Contract).deposit(TABLE_ID, 2, LEGAL_BUY_IN);
  }

  /**
   * Open a real hand (with a committed shuffle) against a deterministic seed.
   * @param seats Seats dealt in; a second concurrent hand must use different ones, because
   *        `openHand` refuses a seat that is already committed to another live hand.
   */
  async function openHandFor(label: string, seats: number[] = [0, 1]): Promise<string> {
    const handText = `${tableIdText}-${label}`;
    const handId = ethers.keccak256(ethers.toUtf8Bytes(handText));
    const seed = ethers.keccak256(ethers.toUtf8Bytes(`${handText}-seed`));
    await commitHiddenDeck(stack, handId, seed, 1n);
    await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
    return handId;
  }

  /** Sign + relay one action for the resident hand, returning the receipt. */
  async function record(
    handId: string,
    handText: string,
    fields: { seat?: number; action: number; amount?: bigint; nonce: bigint; deadline?: bigint },
    overrides: { wallet?: ethers.Wallet; signature?: string } = {},
  ): Promise<any> {
    const { signature } = await signAction({
      wallet: overrides.wallet ?? occupant,
      chainId,
      pokerAddress,
      agentId,
      tableId: tableIdText,
      handId: handText,
      seat: fields.seat ?? 0,
      action: fields.action,
      amount: fields.amount,
      nonce: fields.nonce,
      deadline: fields.deadline ?? FAR_FUTURE,
    });
    return poker
      .connect(stack.operator)
      .recordAction(
        TABLE_ID,
        handId,
        fields.seat ?? 0,
        fields.action,
        fields.amount ?? 0n,
        fields.nonce,
        fields.deadline ?? FAR_FUTURE,
        agentId,
        overrides.signature ?? signature,
      );
  }

  describe('typehash compatibility with the off-chain signer', () => {
    it('exposes a typehash derived from the same type string the server declares', async () => {
      // Derived with `ethers` rather than pasted: `encodeType` is literally the type string, so
      // its keccak256 IS the EIP-712 typehash. A hand-copied constant could drift from the
      // server's `AGENT_ACTION_TYPES` and every test below would still pass with a signature
      // that no real agent could produce.
      const expected = ethers.keccak256(ethers.toUtf8Bytes(ACTION_TYPE_STRING));
      expect(await poker.AGENT_ACTION_TYPEHASH()).to.equal(expected);

      // `ethers` builds the same struct hash from those `types`, so the digest is compatible in
      // both directions. Cross-checked against the shared package's vectors elsewhere; the point
      // here is that the contract's *type string* is the one `ethers` encodes.
      expect(
        ethers.TypedDataEncoder.hashStruct('AgentAction', ACTION_TYPES as never, {
          agentId,
          tableId: tableIdText,
          handId: 'h',
          seat: 0,
          action: ACTION.FOLD,
          amount: 0n,
          nonce: 0n,
          deadline: 0n,
        }),
      ).to.match(/^0x[0-9a-f]{64}$/);
    });

    it('signs and records an action the contract accepts, attributing it to the seat occupant', async () => {
      await seatSigner();
      const handText = `${tableIdText}-h1`;
      const handId = await openHandFor('h1');
      const nonce = nextNonce();

      const { signature } = await signAction({
        wallet: occupant,
        chainId,
        pokerAddress,
        agentId,
        tableId: tableIdText,
        handId: handText,
        seat: 0,
        action: ACTION.RAISE,
        amount: ethers.parseEther('3'),
        nonce,
        deadline: FAR_FUTURE,
      });

      // The load-bearing cross-language check: the digest `ethers` signs is the digest the
      // contract rebuilds, computed here from the typehash and domain rather than trusted.
      const digest = contractDigest({
        domain: domainFor(pokerAddress, chainId),
        tableText: tableIdText,
        handText,
        agentId,
        seat: 0,
        action: ACTION.RAISE,
        amount: ethers.parseEther('3'),
        nonce,
        deadline: FAR_FUTURE,
      });
      expect(digest).to.equal(
        ethers.TypedDataEncoder.hash(domainFor(pokerAddress, chainId), ACTION_TYPES as never, actionMessage({
          agentId,
          tableId: tableIdText,
          handId: handText,
          seat: 0,
          action: ACTION.RAISE,
          amount: ethers.parseEther('3'),
          nonce,
          deadline: FAR_FUTURE,
        }) as never),
      );
      // And the signature really does recover to the seat occupant over that digest — i.e. the
      // agent's own wallet, not the operator's, authorises the record.
      expect(ethers.recoverAddress(digest, signature)).to.equal(await occupant.getAddress());

      const tx = await poker
        .connect(stack.operator)
        .recordAction(TABLE_ID, handId, 0, ACTION.RAISE, ethers.parseEther('3'), nonce, FAR_FUTURE, agentId, signature);
      const receipt = await tx.wait();

      // The emitted signer is the seat occupant, so the record is attributable from the log.
      const parsed = receipt.logs
        .map((log: any) => {
          try {
            return poker.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((entry: any) => entry?.name === 'ActionRecorded');
      expect(parsed, 'ActionRecorded event missing').to.not.equal(undefined);
      expect(parsed.args[0]).to.equal(TABLE_ID);
      expect(parsed.args[1]).to.equal(handId);
      expect(parsed.args[2]).to.equal(0n);
      expect(parsed.args[3]).to.equal(BigInt(ACTION.RAISE));
      expect(parsed.args[4]).to.equal(ethers.parseEther('3'));
      expect(parsed.args[5]).to.equal(nonce);
      expect(parsed.args[6]).to.equal(await occupant.getAddress());
      expect(await poker.occupantOf(TABLE_ID, 0)).to.equal(await occupant.getAddress());
    });

    it('binds the recovered signer to the seat occupant, not merely to a valid signature', async () => {
      await seatSigner();
      const handId = await openHandFor('h2');
      const nonce = nextNonce();

      // A completely valid signature — from the *other* seat's wallet.
      const other = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)));
      const { signature } = await signAction({
        wallet: other,
        chainId,
        pokerAddress,
        agentId,
        tableId: tableIdText,
        handId: `${tableIdText}-h2`,
        seat: 0,
        action: ACTION.CHECK,
        nonce,
        deadline: FAR_FUTURE,
      });

      await expect(
        poker.connect(stack.operator).recordAction(TABLE_ID, handId, 0, ACTION.CHECK, 0n, nonce, FAR_FUTURE, agentId, signature),
      )
        .to.be.revertedWithCustomError(poker, 'ActionSignerMismatch')
        .withArgs(0, await occupant.getAddress(), await other.getAddress());
    });
  });

  describe('amount conventions (FOLD/CHECK/CALL are zero, BET/RAISE carry chips)', () => {
    it('records amount 0 for FOLD, CHECK and CALL and a non-zero amount for BET and RAISE', async () => {
      await seatSigner();
      const handId = await openHandFor('h3');

      for (const action of [ACTION.FOLD, ACTION.CHECK, ACTION.CALL, ACTION.ALL_IN]) {
        await record(handId, `${tableIdText}-h3`, { action, amount: 0n, nonce: nextNonce() });
      }
      await record(handId, `${tableIdText}-h3`, { action: ACTION.BET, amount: ethers.parseEther('1'), nonce: nextNonce() });
      await record(handId, `${tableIdText}-h3`, {
        action: ACTION.RAISE,
        amount: ethers.parseEther('2.5'),
        nonce: nextNonce(),
      });

      expect(await poker.actionCountOf(handId)).to.equal(6n);
    });

    it('records a zero-amount BET faithfully rather than inventing a size (legality is the engine\'s)', async () => {
      // The contract must not "fix" the amount: it is part of the signed payload, so a different
      // value would invalidate the signature. An illegal-but-signed action is recorded as signed.
      await seatSigner();
      const handId = await openHandFor('h4');
      const nonce = nextNonce();
      await expect(record(handId, `${tableIdText}-h4`, { action: ACTION.BET, amount: 0n, nonce }))
        .to.emit(poker, 'ActionRecorded')
        .withArgs(TABLE_ID, handId, 0, BigInt(ACTION.BET), 0n, nonce, await occupant.getAddress());
    });
  });

  describe('the action chain is tamper-evident and ordered', () => {
    it('changes between two actions and is stable across reads (replayable by a verifier)', async () => {
      await seatSigner();
      const handText = `${tableIdText}-h5`;
      const handId = await openHandFor('h5');

      expect(await poker.actionChainOf(handId)).to.equal(ethers.ZeroHash);
      expect(await poker.actionCountOf(handId)).to.equal(0n);

      const nonceA = nextNonce();
      const a = { seat: 0, action: ACTION.CALL, amount: 0n, nonce: nonceA };
      await record(handId, handText, a);
      const afterFirst = await poker.actionChainOf(handId);
      expect(afterFirst).to.not.equal(ethers.ZeroHash);
      expect(await poker.actionCountOf(handId)).to.equal(1n);

      // A view read is a view read: the commitment does not drift between calls.
      expect(await poker.actionChainOf(handId)).to.equal(afterFirst);

      const nonceB = nextNonce();
      const b = { seat: 0, action: ACTION.RAISE, amount: ethers.parseEther('4'), nonce: nonceB };
      await record(handId, handText, b);
      const afterSecond = await poker.actionChainOf(handId);
      expect(afterSecond).to.not.equal(afterFirst);
      expect(await poker.actionChainOf(handId)).to.equal(afterSecond);
      expect(await poker.actionCountOf(handId)).to.equal(2n);

      // Reproduced independently, exactly as a verifier replaying the emitted events would:
      // `keccak256(abi.encode(prev, tableId, handId, seat, action, amount, nonce))`.
      const abi = ethers.AbiCoder.defaultAbiCoder();
      const encodeChain = (prev: string, fields: { seat: number; action: number; amount: bigint; nonce: bigint }) =>
        ethers.keccak256(
          abi.encode(
            ['bytes32', 'bytes32', 'bytes32', 'uint8', 'uint8', 'uint256', 'uint256'],
            [prev, TABLE_ID, handId, fields.seat, fields.action, fields.amount, fields.nonce],
          ),
        );
      const replayed = encodeChain(encodeChain(ethers.ZeroHash, a), b);
      expect(afterSecond).to.equal(replayed);
    });

    it('tracks the last nonce per seat, not per hand', async () => {
      await seatSigner();
      const handId = await openHandFor('h6');

      const seatZero = nextNonce();
      await record(handId, `${tableIdText}-h6`, { seat: 0, action: ACTION.CHECK, nonce: seatZero });
      expect(await poker.lastActionNonceOf(handId, 0)).to.equal(seatZero);
      expect(await poker.lastActionNonceOf(handId, 1)).to.equal(0n);
    });
  });

  describe('rejections', () => {
    it('rejects a signature from a wallet that does not occupy the seat', async () => {
      await seatSigner();
      const handId = await openHandFor('r1');
      const other = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)));

      await expect(
        record(handId, `${tableIdText}-r1`, { action: ACTION.CHECK, nonce: nextNonce() }, { wallet: other }),
      )
        .to.be.revertedWithCustomError(poker, 'ActionSignerMismatch')
        .withArgs(0, await occupant.getAddress(), await other.getAddress());
    });

    it('rejects a replayed nonce', async () => {
      await seatSigner();
      const handId = await openHandFor('r2');
      const nonce = nextNonce();

      await record(handId, `${tableIdText}-r2`, { action: ACTION.CALL, nonce });
      await expect(record(handId, `${tableIdText}-r2`, { action: ACTION.CALL, nonce }))
        .to.be.revertedWithCustomError(poker, 'ActionNonceReused')
        .withArgs(0, nonce, nonce);
    });

    it('rejects a non-increasing nonce', async () => {
      await seatSigner();
      const handId = await openHandFor('r3');
      const first = nextNonce();
      // Strictly *between* the first nonce and the next one drawn from the shared sequence, so this
      // action is genuinely a lower nonce arriving after a higher one — not a plain replay.
      const lower = first + 1n;

      await record(handId, `${tableIdText}-r3`, { action: ACTION.CHECK, nonce: lower });
      await expect(record(handId, `${tableIdText}-r3`, { action: ACTION.CHECK, nonce: first }))
        .to.be.revertedWithCustomError(poker, 'ActionNonceReused')
        .withArgs(0, first, lower);
    });

    it('rejects a nonce that skips ahead but is not greater (zero/none recorded edge)', async () => {
      await seatSigner();
      const handId = await openHandFor('r3b');
      // Nonce 0 is never "greater than" the initial 0, so even the first action must move past it.
      await expect(record(handId, `${tableIdText}-r3b`, { action: ACTION.CHECK, nonce: 0n }))
        .to.be.revertedWithCustomError(poker, 'ActionNonceReused')
        .withArgs(0, 0n, 0n);
    });

    it('rejects an expired deadline', async () => {
      await seatSigner();
      const handId = await openHandFor('r4');
      // Well past, not one second past: the record lands in a *later* block than the one read
      // here, so a deadline of `now - 1` could still pass if the mined timestamp happened to equal
      // it. `block.timestamp - 60` is expired no matter how many blocks the relay costs.
      const nowTs = BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp);
      const expired = nowTs - 60n;

      await expect(record(handId, `${tableIdText}-r4`, { action: ACTION.CHECK, nonce: nextNonce(), deadline: expired }))
        .to.be.revertedWithCustomError(poker, 'ActionExpired')
        .withArgs(expired, anyValue);
    });

    it('reverts on the deadline before it ever looks at the nonce or the signature', async () => {
      // Ordering matters: step 2 of `recordAction` is the deadline, step 4 the nonce and step 5 the
      // signature. An expired action with a *reused* nonce and a *foreign* signer must therefore
      // fail on the deadline — proof that expiry cannot be probed past.
      await seatSigner();
      const handId = await openHandFor('r4b');
      const nowTs = BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp);
      const used = nextNonce();
      await record(handId, `${tableIdText}-r4b`, { action: ACTION.CHECK, nonce: used });

      const foreign = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)));
      await expect(
        record(handId, `${tableIdText}-r4b`, { action: ACTION.CHECK, nonce: used, deadline: nowTs - 60n }, { wallet: foreign }),
      )
        .to.be.revertedWithCustomError(poker, 'ActionExpired')
        .withArgs(nowTs - 60n, anyValue);
    });

    it('rejects an action enum above ALL_IN', async () => {
      await seatSigner();
      const handId = await openHandFor('r5');
      await expect(record(handId, `${tableIdText}-r5`, { action: 6, nonce: nextNonce() }))
        .to.be.revertedWithCustomError(poker, 'InvalidActionEnum')
        .withArgs(6);
    });

    it('rejects an unknown table', async () => {
      await seatSigner();
      const handId = await openHandFor('r6');
      const unknown = ethers.encodeBytes32String('nope');
      const nonce = nextNonce();
      const { signature } = await signAction({
        wallet: occupant,
        chainId,
        pokerAddress,
        agentId,
        tableId: tableIdText,
        handId: `${tableIdText}-r6`,
        seat: 0,
        action: ACTION.CHECK,
        nonce,
        deadline: FAR_FUTURE,
      });

      await expect(
        poker.connect(stack.operator).recordAction(unknown, handId, 0, ACTION.CHECK, 0n, nonce, FAR_FUTURE, agentId, signature),
      )
        .to.be.revertedWithCustomError(poker, 'UnknownTable')
        .withArgs(unknown);
    });

    it('rejects a hand that is not open', async () => {
      await seatSigner();
      // A hand that was never opened: the seed/deck may even be committed, but no `openHand` ran.
      const handText = `${tableIdText}-r7`;
      const handId = await openHandFor('r7');
      const unknownHand = ethers.keccak256(ethers.toUtf8Bytes(`${handText}-never-opened`));
      const nonce = nextNonce();
      const { signature } = await signAction({
        wallet: occupant,
        chainId,
        pokerAddress,
        agentId,
        tableId: tableIdText,
        handId: `${handText}-never-opened`,
        seat: 0,
        action: ACTION.CHECK,
        nonce,
        deadline: FAR_FUTURE,
      });

      await expect(
        poker.connect(stack.operator).recordAction(TABLE_ID, unknownHand, 0, ACTION.CHECK, 0n, nonce, FAR_FUTURE, agentId, signature),
      )
        .to.be.revertedWithCustomError(poker, 'UnknownHand')
        .withArgs(TABLE_ID, unknownHand);

      // And a hand that is no longer open: settle it, then try to record.
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('1'));
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 1, ethers.parseEther('1'));
      await poker.connect(stack.operator).settleHand(
        TABLE_ID,
        handId,
        [ethers.parseEther('1'), ethers.parseEther('1')],
        [0],
        [ethers.parseEther('2')],
        false,
      );
      const closedNonce = nextNonce();
      const closed = await signAction({
        wallet: occupant,
        chainId,
        pokerAddress,
        agentId,
        tableId: tableIdText,
        handId: `${tableIdText}-r7`,
        seat: 0,
        action: ACTION.CHECK,
        nonce: closedNonce,
        deadline: FAR_FUTURE,
      });
      await expect(
        poker
          .connect(stack.operator)
          .recordAction(TABLE_ID, handId, 0, ACTION.CHECK, 0n, closedNonce, FAR_FUTURE, agentId, closed.signature),
      )
        .to.be.revertedWithCustomError(poker, 'HandNotOpen')
        .withArgs(handId, 2n);
    });

    it('only lets the operator relay (FR-10.3)', async () => {
      await seatSigner();
      const handId = await openHandFor('r8');
      const nonce = nextNonce();
      const { signature } = await signAction({
        wallet: occupant,
        chainId,
        pokerAddress,
        agentId,
        tableId: tableIdText,
        handId: `${tableIdText}-r8`,
        seat: 0,
        action: ACTION.CHECK,
        nonce,
        deadline: FAR_FUTURE,
      });

      // `gasLimit` is supplied deliberately: without it ethers estimates gas by simulating the call
      // from `occupant`, which has no ETH, and the node answers with a balance failure instead of
      // the authorization revert this test is about.
      await expect(
        poker
          .connect(occupant)
          .recordAction(TABLE_ID, handId, 0, ACTION.CHECK, 0n, nonce, FAR_FUTURE, agentId, signature, { gasLimit: 1_000_000 }),
      ).to.be.revertedWithCustomError(poker, 'NotOperator');
    });

    it('rejects an action against a seat nobody occupies', async () => {
      await seatSigner();
      const handId = await openHandFor('r9');
      // Seat 5 was never funded and never appeared in `openHand`, so `seatOwner` is the zero
      // address — which no signature can recover to.
      await expect(record(handId, `${tableIdText}-r9`, { seat: 5, action: ACTION.CHECK, nonce: nextNonce() }))
        .to.be.revertedWithCustomError(poker, 'ActionSignerMismatch')
        .withArgs(5, ethers.ZeroAddress, await occupant.getAddress());
    });

    it('rejects a seat index outside the table configuration', async () => {
      await seatSigner();
      const handId = await openHandFor('r10');
      await expect(record(handId, `${tableIdText}-r10`, { seat: 9, action: ACTION.CHECK, nonce: nextNonce() }))
        .to.be.revertedWithCustomError(poker, 'InvalidSeat')
        .withArgs(9, 6);
    });

    it('rejects a signature over a different hand, table, amount or agent id', async () => {
      await seatSigner();
      const handId = await openHandFor('r11');
      const nonce = nextNonce();

      // A second hand on its **own table**, actually open, so the relay reaches the signature check
      // rather than stopping at the hand-status one. (`openHand` refuses a seat already committed to
      // a live hand, and a 2-seat minimum means seats 0/1 cannot be split across two hands on one
      // table — hence a second table for the second live hand.)
      const otherTableText = 'low-2';
      const otherTableId = ethers.id(otherTableText);
      await createWagerTable(stack, otherTableId);
      const otherHandText = `${otherTableText}-h1`;
      const otherHandId = ethers.keccak256(ethers.toUtf8Bytes(otherHandText));
      await poker.connect(occupant).deposit(otherTableId, 0, LEGAL_BUY_IN);
      const otherSecond = stack.players[1]!;
      await poker.connect(otherSecond).deposit(otherTableId, 1, LEGAL_BUY_IN);
      const otherSeed = ethers.keccak256(ethers.toUtf8Bytes(`${otherHandText}-seed`));
      await commitHiddenDeck(stack, otherHandId, otherSeed, 1n);
      await poker.connect(stack.operator).openHand(otherTableId, otherHandId, [0, 1]);

      // The same agent signs for the other table's hand; it is then relayed against this one.
      const mismatch = await signAction({
        wallet: occupant,
        chainId,
        pokerAddress,
        agentId,
        tableId: otherTableText,
        handId: otherHandText,
        seat: 0,
        action: ACTION.CHECK,
        nonce,
        deadline: FAR_FUTURE,
      });
      await expect(
        poker
          .connect(stack.operator)
          .recordAction(TABLE_ID, handId, 0, ACTION.CHECK, 0n, nonce, FAR_FUTURE, agentId, mismatch.signature),
      ).to.be.revertedWithCustomError(poker, 'ActionSignerMismatch');

      // A valid signature with the amount swapped after signing: the payload is covered, so the
      // relay must not be able to alter chips, hand, seat or action. Recorded against the *other*
      // table, whose id the signature really does name — so only the tampering can fail.
      const signed = await signAction({
        wallet: occupant,
        chainId,
        pokerAddress,
        agentId,
        tableId: otherTableText,
        handId: otherHandText,
        seat: 0,
        action: ACTION.BET,
        amount: ethers.parseEther('1'),
        nonce: nonce + 1n,
        deadline: FAR_FUTURE,
      });
      await expect(
        poker
          .connect(stack.operator)
          .recordAction(
            otherTableId,
            otherHandId,
            0,
            ACTION.BET,
            ethers.parseEther('2'),
            nonce + 1n,
            FAR_FUTURE,
            agentId,
            signed.signature,
          ),
      ).to.be.revertedWithCustomError(poker, 'ActionSignerMismatch');

      // And tampering with the agentId string invalidates it too (it is a signed field).
      await expect(
        poker
          .connect(stack.operator)
          .recordAction(
            otherTableId,
            otherHandId,
            0,
            ACTION.BET,
            ethers.parseEther('1'),
            nonce + 1n,
            FAR_FUTURE,
            'agent_000000000000',
            signed.signature,
          ),
      ).to.be.revertedWithCustomError(poker, 'ActionSignerMismatch');
    });
  });

  describe('the domain separator is the server\'s domain', () => {
    it('accepts only signatures bound to this chain and this contract address', async () => {
      await seatSigner();
      const handId = await openHandFor('d1');
      const nonce = nextNonce();

      // Same message, wrong chain id: the server would reject it and so must the contract.
      const wrongChain = await signWith(
        occupant,
        { name: 'LLM Poker Arena', version: '1', chainId: chainId + 1, verifyingContract: pokerAddress },
        actionMessage({
          agentId,
          tableId: tableIdText,
          handId: `${tableIdText}-d1`,
          seat: 0,
          action: ACTION.CHECK,
          nonce,
          deadline: FAR_FUTURE,
        }),
      );
      await expect(
        poker.connect(stack.operator).recordAction(TABLE_ID, handId, 0, ACTION.CHECK, 0n, nonce, FAR_FUTURE, agentId, wrongChain),
      ).to.be.revertedWithCustomError(poker, 'ActionSignerMismatch');

      // Same message, wrong verifying contract.
      const wrongContract = await signWith(
        occupant,
        { name: 'LLM Poker Arena', version: '1', chainId, verifyingContract: stack.shuffleAddress },
        actionMessage({
          agentId,
          tableId: tableIdText,
          handId: `${tableIdText}-d1`,
          seat: 0,
          action: ACTION.CHECK,
          nonce: nonce + 1n,
          deadline: FAR_FUTURE,
        }),
      );
      await expect(
        poker
          .connect(stack.operator)
          .recordAction(TABLE_ID, handId, 0, ACTION.CHECK, 0n, nonce + 1n, FAR_FUTURE, agentId, wrongContract),
      ).to.be.revertedWithCustomError(poker, 'ActionSignerMismatch');

      // Same message, wrong domain name.
      const wrongName = await signWith(
        occupant,
        { name: 'LLM Poker', version: '1', chainId, verifyingContract: pokerAddress },
        actionMessage({
          agentId,
          tableId: tableIdText,
          handId: `${tableIdText}-d1`,
          seat: 0,
          action: ACTION.CHECK,
          nonce: nonce + 2n,
          deadline: FAR_FUTURE,
        }),
      );
      await expect(
        poker
          .connect(stack.operator)
          .recordAction(TABLE_ID, handId, 0, ACTION.CHECK, 0n, nonce + 2n, FAR_FUTURE, agentId, wrongName),
      ).to.be.revertedWithCustomError(poker, 'ActionSignerMismatch');

      // The control: the exact domain still works, so the rejections above are about the domain.
      await record(handId, `${tableIdText}-d1`, { action: ACTION.CHECK, nonce: nextNonce() });
      expect(await poker.actionCountOf(handId)).to.equal(1n);
    });

    it('keeps the immutable domain separator valid after the chain advances', async () => {
      // The separator caches `address(this)` and `block.chainid`, never the height or timestamp,
      // so ordinary progression of the chain must not perturb verification.
      await seatSigner();
      const handId = await openHandFor('d2');
      await hre.network.provider.send('evm_mine', []);
      await record(handId, `${tableIdText}-d2`, { action: ACTION.CALL, nonce: nextNonce() });
      expect(await poker.actionCountOf(handId)).to.equal(1n);
    });
  });
});
