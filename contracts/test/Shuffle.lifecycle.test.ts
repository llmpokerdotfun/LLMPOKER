/**
 * Shuffle lifecycle tests: commitment, anchor capture, reveal window, finality, void (FR-6.1–6.6,
 * NFR-6), plus cross-implementation checks of `entropy` and `anchorBlockHash` against the
 * TypeScript arithmetic recomputed here with ethers (`docs/RNG.md` §5 steps 1–5).
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { mineUpTo, time } from '@nomicfoundation/hardhat-network-helpers';

import { commitmentFor, entropyFrom, snapshotFixture, type PokerStack, type SnapshotFixture } from './support/helpers';

const STATE = { None: 0n, Committed: 1n, Revealed: 2n, Voided: 3n } as const;

const SEED_A = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SEED_B = '0x6c6c6d706f6b6572212121212121212121212121212121212121212121212121';

function handIdOf(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

describe('Shuffle — commit / reveal lifecycle (FR-6)', () => {
  // A small K keeps the suite cheap; the shipped default (12) is asserted separately.
  let fixture: SnapshotFixture;
  let stack: PokerStack;
  let shuffle: any;
  let confirmations: bigint;

  before(async () => {
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    shuffle = stack.shuffle;
    confirmations = BigInt(await shuffle.requiredConfirmations());
  });

  beforeEach(async () => {
    await fixture.reset();
  });

  it('defaults to 12 confirmations and a 256-block reveal window (FR-6.1, FR-6.5)', async () => {
    const defaulted = await snapshotFixture(12n);
    expect(await defaulted.stack.shuffle.requiredConfirmations()).to.equal(12n);
    expect(await defaulted.stack.shuffle.REVEAL_WINDOW_BLOCKS()).to.equal(256n);
    expect(await defaulted.stack.shuffle.MIN_REQUIRED_CONFIRMATIONS()).to.equal(1n);
  });

  it('restricts commit and reveal to the operator role (FR-10.3)', async () => {
    const handId = handIdOf('role-check');
    const commitment = commitmentFor(SEED_A, 1n);
    await expect(shuffle.connect(stack.players[0]).commit(handId, commitment, 1n)).to.be.revertedWithCustomError(
      shuffle,
      'AccessControlUnauthorizedAccount',
    );

    await shuffle.connect(stack.operator).commit(handId, commitment, 1n);
    await mineUpTo((await shuffle.commitBlockOf(handId)) + 1n + confirmations);
    await expect(shuffle.connect(stack.players[0]).reveal(handId, SEED_A)).to.be.revertedWithCustomError(
      shuffle,
      'AccessControlUnauthorizedAccount',
    );
  });

  it('records the commitment, nonce and commit block, and reverts on a second commit', async () => {
    const handId = handIdOf('commit-once');
    const commitment = commitmentFor(SEED_A, 7n);

    const receipt = await (await shuffle.connect(stack.operator).commit(handId, commitment, 7n)).wait();

    expect(await shuffle.commitmentOf(handId)).to.equal(commitment);
    expect(await shuffle.nonceOf(handId)).to.equal(7n);
    expect(await shuffle.commitBlockOf(handId)).to.equal(BigInt(receipt.blockNumber));
    expect(await shuffle.anchorBlockOf(handId)).to.equal(BigInt(receipt.blockNumber + 1));
    expect(await shuffle.stateOf(handId)).to.equal(STATE.Committed);

    await expect(shuffle.connect(stack.operator).commit(handId, commitmentFor(SEED_B, 7n), 7n))
      .to.be.revertedWithCustomError(shuffle, 'CommitmentExists')
      .withArgs(handId);
  });

  it('emits Committed with the nonce and commit block (FR-6.1)', async () => {
    const handId = handIdOf('commit-event');
    const commitment = commitmentFor(SEED_A, 3n);

    const tx = await shuffle.connect(stack.operator).commit(handId, commitment, 3n);
    const receipt = await tx.wait();
    const parsed = receipt.logs
      .map((log: any) => {
        try {
          return shuffle.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((entry: any) => entry?.name === 'Committed');

    expect(parsed).to.not.equal(undefined);
    expect(parsed.args.handId).to.equal(handId);
    expect(parsed.args.commitment).to.equal(commitment);
    expect(parsed.args.nonce).to.equal(3n);
    expect(parsed.args.commitBlock).to.equal(BigInt(receipt.blockNumber));
  });

  it('reveals on the happy path and stores entropy, anchor hash and the deck (FR-6.1, FR-6.2)', async () => {
    const handId = handIdOf('happy-path');
    const commitment = commitmentFor(SEED_A, 9n);
    const commitReceipt = await (await shuffle.connect(stack.operator).commit(handId, commitment, 9n)).wait();
    const commitBlock = BigInt(commitReceipt.blockNumber);

    await mineUpTo(commitBlock + 1n + confirmations);
    const revealReceipt = await (await shuffle.connect(stack.operator).reveal(handId, SEED_A)).wait();

    // `docs/RNG.md` §5 step 2: the anchor is the public hash of block commitBlock + 1, and the
    // stored value must equal what any verifier recomputes from the chain.
    const anchor = await hre.ethers.provider.getBlock(Number(commitBlock + 1n));
    const anchorBlockHash = anchor!.hash;
    expect(await shuffle.anchorBlockHashOf(handId)).to.equal(anchorBlockHash);
    // §5 step 5: entropy is recomputable by the TypeScript implementation.
    expect(await shuffle.entropyOf(handId)).to.equal(entropyFrom(SEED_A, anchorBlockHash));
    expect(await shuffle.stateOf(handId)).to.equal(STATE.Revealed);
    expect(await shuffle.isRevealed(handId)).to.equal(true);
    expect(await shuffle.revealBlockOf(handId)).to.equal(BigInt(revealReceipt.blockNumber));
    expect(await shuffle.anchorBlockOf(handId)).to.equal(commitBlock + 1n);

    // §5 step 3: inside the reveal window. §5 step 4: finality reached.
    expect(BigInt(revealReceipt.blockNumber)).to.be.greaterThan(commitBlock);
    expect(BigInt(revealReceipt.blockNumber)).to.be.lessThanOrEqual(commitBlock + 256n);
    expect(BigInt(revealReceipt.blockNumber)).to.be.greaterThanOrEqual(commitBlock + 1n + confirmations);

    // §5 step 6: the stored deck is the documented function of the stored entropy.
    const expected = await shuffle.computeDeck(await shuffle.entropyOf(handId));
    const stored = await shuffle.deckOf(handId);
    expect(Array.from(stored as bigint[], (c) => Number(c))).to.deep.equal(
      Array.from(expected as bigint[], (c) => Number(c)),
    );
  });

  it('emits the full proof in Revealed (FR-6.3, NFR-4)', async () => {
    const handId = handIdOf('reveal-event');
    const commitment = commitmentFor(SEED_B, 11n);
    const commitReceipt = await (await shuffle.connect(stack.operator).commit(handId, commitment, 11n)).wait();
    await mineUpTo(BigInt(commitReceipt.blockNumber) + 1n + confirmations);

    const receipt = await (await shuffle.connect(stack.operator).reveal(handId, SEED_B)).wait();
    const parsed = receipt.logs
      .map((log: any) => {
        try {
          return shuffle.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((entry: any) => entry?.name === 'Revealed');

    expect(parsed).to.not.equal(undefined);
    expect(parsed.args.handId).to.equal(handId);
    expect(parsed.args.commitment).to.equal(commitment);
    expect(parsed.args.deckSeed).to.equal(SEED_B);
    expect(parsed.args.nonce).to.equal(11n);
    expect(parsed.args.commitBlock).to.equal(BigInt(commitReceipt.blockNumber));
    expect(parsed.args.anchorBlock).to.equal(BigInt(commitReceipt.blockNumber + 1));
    expect(parsed.args.entropy).to.equal(await shuffle.entropyOf(handId));
    expect(parsed.args.anchorBlockHash).to.equal(await shuffle.anchorBlockHashOf(handId));
    expect(parsed.args.revealBlock).to.equal(BigInt(receipt.blockNumber));
    expect(parsed.args.deck.length).to.equal(52);
  });

  it('reverts on a wrong seed and leaves the commitment untouched', async () => {
    const handId = handIdOf('wrong-seed');
    const commitment = commitmentFor(SEED_A, 5n);
    const commitReceipt = await (await shuffle.connect(stack.operator).commit(handId, commitment, 5n)).wait();
    await mineUpTo(BigInt(commitReceipt.blockNumber) + 1n + confirmations);

    await expect(shuffle.connect(stack.operator).reveal(handId, SEED_B)).to.be.revertedWithCustomError(
      shuffle,
      'CommitmentMismatch',
    );

    expect(await shuffle.commitmentOf(handId)).to.equal(commitment);
    expect(await shuffle.stateOf(handId)).to.equal(STATE.Committed);
  });

  it('reverts a reveal before the anchor confirmations (FR-6.5, NFR-6)', async () => {
    const handId = handIdOf('too-early');
    const commitment = commitmentFor(SEED_A, 13n);
    const commitReceipt = await (await shuffle.connect(stack.operator).commit(handId, commitment, 13n)).wait();
    const commitBlock = BigInt(commitReceipt.blockNumber);

    // One block after the commit is inside the reveal window but one confirmation short.
    await mineUpTo(commitBlock + 1n);
    expect(await shuffle.earliestRevealBlockOf(handId)).to.equal(commitBlock + 1n + confirmations);
    await expect(shuffle.connect(stack.operator).reveal(handId, SEED_A))
      .to.be.revertedWithCustomError(shuffle, 'InsufficientConfirmations')
      .withArgs(commitBlock + 2n, commitBlock + 1n + confirmations);
  });

  it('reverts a reveal past block commitBlock + 256 (FR-6.1, FR-6.6)', async () => {
    const handId = handIdOf('too-late');
    const commitment = commitmentFor(SEED_A, 19n);
    const commitReceipt = await (await shuffle.connect(stack.operator).commit(handId, commitment, 19n)).wait();
    const commitBlock = BigInt(commitReceipt.blockNumber);

    // The last legal reveal block is commitBlock + 256; the block after it must be rejected.
    // The reveal tx itself lands one block after `mineUpTo`, i.e. commitBlock + 258.
    await mineUpTo(commitBlock + 257n);
    expect(await shuffle.voidableFromBlockOf(handId)).to.equal(commitBlock + 257n);
    await expect(shuffle.connect(stack.operator).reveal(handId, SEED_A))
      .to.be.revertedWithCustomError(shuffle, 'OutsideRevealWindow')
      .withArgs(commitBlock, commitBlock + 258n);
  });

  it('exposes the documented view surface for unknown hands', async () => {
    const unknown = handIdOf('unknown');
    expect(await shuffle.commitmentOf(unknown)).to.equal(ethers.ZeroHash);
    expect(await shuffle.stateOf(unknown)).to.equal(STATE.None);
    expect(await shuffle.anchorBlockOf(unknown)).to.equal(0n);
    expect(await shuffle.anchorBlockHashOf(unknown)).to.equal(ethers.ZeroHash);
    expect(await shuffle.entropyOf(unknown)).to.equal(ethers.ZeroHash);
    expect(await shuffle.isRevealed(unknown)).to.equal(false);
    expect(await shuffle.deckOf(unknown)).to.deep.equal(new Array(52).fill(0n));
    await expect(shuffle.connect(stack.operator).reveal(unknown, SEED_A)).to.be.revertedWithCustomError(
      shuffle,
      'UnknownHand',
    );
  });

  describe('void / expiry path (FR-6.6)', () => {
    it('cannot be voided while the reveal window is open', async () => {
      const handId = handIdOf('void-too-early');
      const commitReceipt = await (
        await shuffle.connect(stack.operator).commit(handId, commitmentFor(SEED_A, 23n), 23n)
      ).wait();
      const commitBlock = BigInt(commitReceipt.blockNumber);

      await expect(shuffle.connect(stack.players[0]).void(handId))
        .to.be.revertedWithCustomError(shuffle, 'RevealWindowOpen')
        .withArgs(commitBlock, commitBlock + 257n);
    });

    it('anyone can void an expired hand, and a voided hand cannot be revealed', async () => {
      const handId = handIdOf('void-expired');
      const commitReceipt = await (
        await shuffle.connect(stack.operator).commit(handId, commitmentFor(SEED_A, 29n), 29n)
      ).wait();
      const commitBlock = BigInt(commitReceipt.blockNumber);
      await mineUpTo(commitBlock + 257n);

      await expect(shuffle.connect(stack.players[0]).void(handId))
        .to.emit(shuffle, 'Voided')
        .withArgs(handId, commitBlock, commitBlock + 258n);

      expect(await shuffle.stateOf(handId)).to.equal(STATE.Voided);
      expect(await shuffle.isRevealed(handId)).to.equal(false);

      await expect(shuffle.connect(stack.operator).reveal(handId, SEED_A)).to.be.revertedWithCustomError(
        shuffle,
        'HandNotPending',
      );
      await expect(shuffle.connect(stack.players[1]).void(handId)).to.be.revertedWithCustomError(
        shuffle,
        'HandNotPending',
      );
    });

    it('rejects void() for a hand that was already revealed', async () => {
      const handId = handIdOf('void-after-reveal');
      const commitReceipt = await (
        await shuffle.connect(stack.operator).commit(handId, commitmentFor(SEED_A, 31n), 31n)
      ).wait();
      await mineUpTo(BigInt(commitReceipt.blockNumber) + 1n + confirmations);
      await shuffle.connect(stack.operator).reveal(handId, SEED_A);

      await expect(shuffle.connect(stack.players[0]).void(handId)).to.be.revertedWithCustomError(
        shuffle,
        'HandNotPending',
      );
    });
  });

  describe('requiredConfirmations bounds (FR-6.5, FR-9.7)', () => {
    it('rejects out-of-range constructor values', async () => {
      const [owner] = await hre.ethers.getSigners();
      const factory = await hre.ethers.getContractFactory('Shuffle', owner);
      await expect(factory.deploy(await owner.getAddress(), 0n)).to.be.revertedWithCustomError(
        factory,
        'InvalidRequiredConfirmations',
      );
      await expect(factory.deploy(await owner.getAddress(), 129n)).to.be.revertedWithCustomError(
        factory,
        'InvalidRequiredConfirmations',
      );
    });

    it('lets the owner retune within bounds only', async () => {
      await expect(shuffle.connect(stack.owner).setRequiredConfirmations(24n))
        .to.emit(shuffle, 'RequiredConfirmationsUpdated')
        .withArgs(2n, 24n);
      expect(await shuffle.requiredConfirmations()).to.equal(24n);

      await expect(shuffle.connect(stack.owner).setRequiredConfirmations(0n)).to.be.revertedWithCustomError(
        shuffle,
        'InvalidRequiredConfirmations',
      );
      await expect(shuffle.connect(stack.owner).setRequiredConfirmations(129n)).to.be.revertedWithCustomError(
        shuffle,
        'InvalidRequiredConfirmations',
      );
      await expect(shuffle.connect(stack.players[0]).setRequiredConfirmations(5n)).to.be.revertedWithCustomError(
        shuffle,
        'AccessControlUnauthorizedAccount',
      );
    });

    it('never lets the threshold push a reveal outside the 256-block window', async () => {
      expect(await shuffle.MAX_REQUIRED_CONFIRMATIONS()).to.be.lessThan(await shuffle.REVEAL_WINDOW_BLOCKS());
    });
  });

  it('cannot rewrite a recorded commitment, anchor, entropy or deck (FR-10)', async () => {
    const handId = handIdOf('immutable-record');
    const commitReceipt = await (
      await shuffle.connect(stack.operator).commit(handId, commitmentFor(SEED_A, 37n), 37n)
    ).wait();
    await mineUpTo(BigInt(commitReceipt.blockNumber) + 1n + confirmations);
    await shuffle.connect(stack.operator).reveal(handId, SEED_A);

    const entropy = await shuffle.entropyOf(handId);
    const anchor = await shuffle.anchorBlockHashOf(handId);
    const deck = await shuffle.deckOf(handId);
    const commitment = await shuffle.commitmentOf(handId);

    // Re-committing the same hand is refused, and no owner call can touch the record.
    await expect(shuffle.connect(stack.operator).commit(handId, commitmentFor(SEED_B, 41n), 41n))
      .to.be.revertedWithCustomError(shuffle, 'CommitmentExists')
      .withArgs(handId);
    await expect(shuffle.connect(stack.owner).reveal(handId, SEED_B)).to.be.revertedWithCustomError(
      shuffle,
      'HandNotPending',
    );

    expect(await shuffle.entropyOf(handId)).to.equal(entropy);
    expect(await shuffle.anchorBlockHashOf(handId)).to.equal(anchor);
    expect(await shuffle.commitmentOf(handId)).to.equal(commitment);
    expect(await shuffle.deckOf(handId)).to.deep.equal(deck);
  });

  it('rejects a zero hand id', async () => {
    await expect(shuffle.connect(stack.operator).commit(ethers.ZeroHash, commitmentFor(SEED_A, 1n), 1n))
      .to.be.revertedWithCustomError(shuffle, 'UnknownHand')
      .withArgs(ethers.ZeroHash);
  });

  it('keeps independent hands independent (no cross-hand contamination)', async () => {
    const first = handIdOf('independence-a');
    const second = handIdOf('independence-b');
    await shuffle.connect(stack.operator).commit(first, commitmentFor(SEED_A, 43n), 43n);
    const secondReceipt = await (
      await shuffle.connect(stack.operator).commit(second, commitmentFor(SEED_B, 47n), 47n)
    ).wait();

    await mineUpTo(BigInt(secondReceipt.blockNumber) + 1n + confirmations);
    await shuffle.connect(stack.operator).reveal(first, SEED_A);
    await shuffle.connect(stack.operator).reveal(second, SEED_B);

    expect(await shuffle.entropyOf(first)).to.not.equal(await shuffle.entropyOf(second));
    expect(await shuffle.deckOf(first)).to.not.deep.equal(await shuffle.deckOf(second));
  });

  it('is block-timestamp independent: warping the clock does not disturb a committed hand', async () => {
    const handId = handIdOf('time-independent');
    const commitment = commitmentFor(SEED_A, 53n);
    const commitReceipt = await (await shuffle.connect(stack.operator).commit(handId, commitment, 53n)).wait();
    await time.increase(3600);
    await mineUpTo(BigInt(commitReceipt.blockNumber) + 1n + confirmations);
    await shuffle.connect(stack.operator).reveal(handId, SEED_A);
    expect(await shuffle.isRevealed(handId)).to.equal(true);
  });
});
