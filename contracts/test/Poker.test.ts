/**
 * Poker tests (FR-5, FR-8, FR-10.3, FR-10.5): escrow and buy-in bounds, the operator seating
 * prohibition, hand lifecycle with on-chain-verified settlement, rake (bps, cap, flop-only),
 * double-settlement and shuffle-state guards, the void/refund path and pause semantics.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { mineUpTo } from '@nomicfoundation/hardhat-network-helpers';

import {
  RAKE,
  TABLE_CONFIG,
  TABLE_ID,
  commitHand,
  createWagerTable,
  expectedRake,
  revealHand,
  seatKey,
  snapshotFixture,
  type PokerStack,
  type SnapshotFixture,
} from './support/helpers';

const LEGAL_BUY_IN = ethers.parseEther('20');
const SEATS = [0, 1, 2, 3, 4, 5];

function handIdOf(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

describe('Poker (FR-5, FR-8, FR-10.3, FR-10.5)', () => {
  let fixture: SnapshotFixture;
  let stack: PokerStack;
  let poker: any;

  before(async () => {
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    poker = stack.poker;
  });

  beforeEach(async () => {
    await fixture.reset();
    await createWagerTable(stack);
  });

  async function seatAll(seats: number[] = SEATS, amount: bigint = LEGAL_BUY_IN): Promise<void> {
    for (const seat of seats) {
      await poker.connect(stack.players[seat]).deposit(TABLE_ID, seat, amount);
    }
  }

  /** Open a hand, commit chips, reveal the shuffle and settle it with `winner` taking the pot. */
  async function playHand(
    handId: string,
    options: {
      seats?: number[];
      contributions?: bigint[];
      winner?: number;
      sawFlop?: boolean;
      losersAlso?: boolean;
    } = {},
  ): Promise<{ pot: bigint; rake: bigint; award: bigint }> {
    const seats = options.seats ?? SEATS;
    const contributions = options.contributions ?? seats.map(() => ethers.parseEther('20'));
    const winner = options.winner ?? seats[0]!;
    const sawFlop = options.sawFlop ?? true;

    const seed = ethers.keccak256(ethers.toUtf8Bytes(`${handId}-seed`));
    await commitHand(stack, handId, seed, 1n);
    await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
    for (const [index, seat] of seats.entries()) {
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, seat, contributions[index]!);
    }
    await revealHand(stack, handId, seed);

    const pot = contributions.reduce((a, b) => a + b, 0n);
    const rake = expectedRake(pot, TABLE_CONFIG.rakeBps, TABLE_CONFIG.rakeCap, sawFlop);
    const award = pot - rake;
    await poker.connect(stack.operator).settleHand(TABLE_ID, handId, contributions, [winner], [award], sawFlop);
    return { pot, rake, award };
  }

  describe('table configuration (FR-5.1, FR-8.1)', () => {
    it('stores the created table and exposes it', async () => {
      const config = await poker.tableConfigOf(TABLE_ID);
      expect(config.smallBlind).to.equal(TABLE_CONFIG.smallBlind);
      expect(config.bigBlind).to.equal(TABLE_CONFIG.bigBlind);
      expect(config.minBuyIn).to.equal(TABLE_CONFIG.minBuyIn);
      expect(config.maxBuyIn).to.equal(TABLE_CONFIG.maxBuyIn);
      expect(config.rakeBps).to.equal(RAKE.bps);
      expect(config.rakeCap).to.equal(RAKE.cap);
      expect(config.maxSeats).to.equal(6n);
      expect(await poker.MAX_SEATS()).to.equal(6n);
    });

    it('only lets the owner create wager tables (FR-10.3)', async () => {
      await expect(
        poker.connect(stack.operator).createTable(ethers.encodeBytes32String('x'), TABLE_CONFIG),
      ).to.be.revertedWithCustomError(poker, 'OwnableUnauthorizedAccount');
    });

    it('rejects a duplicate table id', async () => {
      await expect(poker.connect(stack.owner).createTable(TABLE_ID, TABLE_CONFIG)).to.be.revertedWithCustomError(
        poker,
        'TableExists',
      );
    });

    it('enforces the config bounds, including the 1000 bps rake cap (FR-8.1)', async () => {
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['zero small blind', { smallBlind: 0n }, 'smallBlind must be > 0'],
        ['bigBlind not 2x', { bigBlind: 1n }, 'bigBlind must be 2x smallBlind'],
        ['minBuyIn below 10bb', { minBuyIn: 1n }, 'minBuyIn must be >= 10 big blinds'],
        ['maxBuyIn below minBuyIn', { maxBuyIn: 1n, minBuyIn: ethers.parseEther('5') }, 'maxBuyIn must be >= minBuyIn'],
        ['rake above cap', { rakeBps: 1_001n }, 'rakeBps must be <= 1000'],
        ['too many seats', { maxSeats: 7 }, 'maxSeats must be 2..6'],
        ['too few seats', { maxSeats: 1 }, 'maxSeats must be 2..6'],
      ];
      for (const [label, override, reason] of cases) {
        await expect(
          poker.connect(stack.owner).createTable(ethers.encodeBytes32String(label), { ...TABLE_CONFIG, ...override }),
        )
          .to.be.revertedWithCustomError(poker, 'InvalidTableConfig')
          .withArgs(reason);
      }
    });

    it('reports the flop-only rake policy on-chain (FR-8.1, SRS §11 Q2)', async () => {
      expect(await poker.DEFAULT_RAKE_ONLY_WITH_FLOP()).to.equal(true);
      expect(await poker.MAX_RAKE_BPS()).to.equal(1_000n);
    });
  });

  describe('computeRake mirrors packages/shared/src/config.ts (FR-8.1)', () => {
    it('is bps of the pot, capped, and zero without a flop', async () => {
      const pot = ethers.parseEther('100');
      // 250 bps of 100 = 0.25, above the 0.05 cap.
      expect(await poker.computeRake(pot, 250n, RAKE.cap, true, true)).to.equal(RAKE.cap);
      // Under the cap: 250 bps of 0.1 token = 0.0025.
      expect(await poker.computeRake(ethers.parseEther('0.1'), 250n, RAKE.cap, true, true)).to.equal(
        ethers.parseEther('0.0025'),
      );
      // Rake-only-with-flop policy and zero bps both yield zero.
      expect(await poker.computeRake(pot, 250n, RAKE.cap, false, true)).to.equal(0n);
      expect(await poker.computeRake(pot, 0n, RAKE.cap, true, true)).to.equal(0n);
      // The policy flag is what zeroes it, not the absence of rake.
      expect(await poker.computeRake(pot, 250n, RAKE.cap, false, false)).to.equal(RAKE.cap);
      // Floor division, not rounding.
      expect(await poker.computeRake(199n, 250n, RAKE.cap, true, true)).to.equal(4n);
      // Zero cap.
      expect(await poker.computeRake(pot, 250n, 0n, true, true)).to.equal(0n);
    });

    it('matches a locally computed reference over a spread of pots', async () => {
      for (const pot of [1n, 99n, 199n, 10n ** 15n, ethers.parseEther('1'), ethers.parseEther('7.5')]) {
        const expected = expectedRake(pot, RAKE.bps, RAKE.cap, true);
        expect(await poker.computeRake(pot, RAKE.bps, RAKE.cap, true, true)).to.equal(expected);
      }
    });
  });

  describe('escrow lifecycle (FR-5.1, FR-5.5, FR-10.3)', () => {
    it('accepts a deposit inside the buy-in range and records per-seat escrow', async () => {
      const player = stack.players[0]!;
      const address = stack.playerAddresses[0]!;
      await expect(poker.connect(player).deposit(TABLE_ID, 0, LEGAL_BUY_IN))
        .to.emit(poker, 'Deposited')
        .withArgs(TABLE_ID, 0, address, LEGAL_BUY_IN, LEGAL_BUY_IN)
        .and.to.emit(poker, 'SeatTaken')
        .withArgs(TABLE_ID, 0, address);

      expect(await poker.escrowBalanceOf(TABLE_ID, 0)).to.equal(LEGAL_BUY_IN);
      expect(await poker.occupantOf(TABLE_ID, 0)).to.equal(address);
      expect(await poker.seatCountOf(TABLE_ID)).to.equal(1n);
      // Custody is real.
      expect(await stack.token.balanceOf(stack.pokerAddress)).to.equal(LEGAL_BUY_IN);
    });

    it('enforces min and max buy-in across top-ups (FR-5.1)', async () => {
      const player = stack.players[0]!;
      // Below the 5-token minimum.
      await expect(poker.connect(player).deposit(TABLE_ID, 0, ethers.parseEther('4')))
        .to.be.revertedWithCustomError(poker, 'BuyInOutOfRange')
        .withArgs(ethers.parseEther('4'), TABLE_CONFIG.minBuyIn, TABLE_CONFIG.maxBuyIn);
      // Above the 25-token maximum.
      await expect(poker.connect(player).deposit(TABLE_ID, 0, ethers.parseEther('25.1')))
        .to.be.revertedWithCustomError(poker, 'BuyInOutOfRange')
        .withArgs(ethers.parseEther('25.1'), TABLE_CONFIG.minBuyIn, TABLE_CONFIG.maxBuyIn);

      // The *resulting* balance is what is bounded, so 5 + 21 is rejected and 5 + 20 accepted.
      await poker.connect(player).deposit(TABLE_ID, 0, TABLE_CONFIG.minBuyIn);
      await expect(poker.connect(player).deposit(TABLE_ID, 0, ethers.parseEther('21')))
        .to.be.revertedWithCustomError(poker, 'BuyInOutOfRange')
        .withArgs(ethers.parseEther('26'), TABLE_CONFIG.minBuyIn, TABLE_CONFIG.maxBuyIn);
      await poker.connect(player).deposit(TABLE_ID, 0, ethers.parseEther('20'));
      expect(await poker.escrowBalanceOf(TABLE_ID, 0)).to.equal(TABLE_CONFIG.maxBuyIn);
    });

    it('rejects a zero deposit and an out-of-range seat', async () => {
      await expect(poker.connect(stack.players[0]!).deposit(TABLE_ID, 0, 0n)).to.be.revertedWithCustomError(
        poker,
        'BuyInOutOfRange',
      );
      await expect(poker.connect(stack.players[0]!).deposit(TABLE_ID, 6, LEGAL_BUY_IN))
        .to.be.revertedWithCustomError(poker, 'InvalidSeat')
        .withArgs(6, 6);
    });

    it('rejects an unknown table', async () => {
      const unknown = ethers.encodeBytes32String('nope');
      await expect(poker.connect(stack.players[0]!).deposit(unknown, 0, LEGAL_BUY_IN))
        .to.be.revertedWithCustomError(poker, 'UnknownTable')
        .withArgs(unknown);
    });

    it('refuses to let a different player take an occupied seat', async () => {
      await poker.connect(stack.players[0]!).deposit(TABLE_ID, 0, LEGAL_BUY_IN);
      await expect(poker.connect(stack.players[1]!).deposit(TABLE_ID, 0, LEGAL_BUY_IN))
        .to.be.revertedWithCustomError(poker, 'SeatOccupied')
        .withArgs(0, stack.playerAddresses[0]!);
    });

    it('blocks the operator from seating at its own wager table (FR-10.3)', async () => {
      await expect(poker.connect(stack.operator).deposit(TABLE_ID, 0, LEGAL_BUY_IN))
        .to.be.revertedWithCustomError(poker, 'OperatorCannotSeat')
        .withArgs(stack.operatorAddress);

      // Rotating the operator moves the prohibition with it.
      await poker.connect(stack.owner).setOperator(stack.playerAddresses[5]!);
      await expect(poker.connect(stack.players[5]!).deposit(TABLE_ID, 0, LEGAL_BUY_IN))
        .to.be.revertedWithCustomError(poker, 'OperatorCannotSeat')
        .withArgs(stack.playerAddresses[5]!);
      // The old operator is now an ordinary player.
      await expect(poker.connect(stack.operator).deposit(TABLE_ID, 0, LEGAL_BUY_IN)).to.not.be.reverted;
    });

    it('cashes out the full escrow and releases the seat (FR-5.5)', async () => {
      const player = stack.players[0]!;
      const address = stack.playerAddresses[0]!;
      await poker.connect(player).deposit(TABLE_ID, 0, LEGAL_BUY_IN);
      const before = await stack.token.balanceOf(address);

      await expect(poker.connect(player).cashOut(TABLE_ID, 0))
        .to.emit(poker, 'CashedOut')
        .withArgs(TABLE_ID, 0, address, LEGAL_BUY_IN)
        .and.to.emit(poker, 'SeatReleased')
        .withArgs(TABLE_ID, 0, address);

      expect((await stack.token.balanceOf(address)) - before).to.equal(LEGAL_BUY_IN);
      expect(await poker.escrowBalanceOf(TABLE_ID, 0)).to.equal(0n);
      expect(await poker.occupantOf(TABLE_ID, 0)).to.equal(ethers.ZeroAddress);
      expect(await poker.seatCountOf(TABLE_ID)).to.equal(0n);
      expect(await stack.token.balanceOf(stack.pokerAddress)).to.equal(0n);
    });

    it('refuses a cash-out from a non-occupant or an empty seat', async () => {
      await poker.connect(stack.players[0]!).deposit(TABLE_ID, 0, LEGAL_BUY_IN);
      await expect(poker.connect(stack.players[1]!).cashOut(TABLE_ID, 0))
        .to.be.revertedWithCustomError(poker, 'NoPosition');
      await expect(poker.connect(stack.players[1]!).cashOut(TABLE_ID, 3))
        .to.be.revertedWithCustomError(poker, 'NoPosition');
    });

    it('keeps per-seat escrow separate across seats and players', async () => {
      await seatAll([0, 1, 2]);
      expect(await poker.escrowBalanceOf(TABLE_ID, 0)).to.equal(LEGAL_BUY_IN);
      expect(await poker.escrowBalanceOf(TABLE_ID, 1)).to.equal(LEGAL_BUY_IN);
      expect(await poker.escrowBalanceOf(TABLE_ID, 2)).to.equal(LEGAL_BUY_IN);
      expect(await poker.escrowBalanceOf(TABLE_ID, 3)).to.equal(0n);
      expect(await poker.seatCountOf(TABLE_ID)).to.equal(3n);
      expect(await stack.token.balanceOf(stack.pokerAddress)).to.equal(LEGAL_BUY_IN * 3n);
    });
  });

  describe('hand lifecycle and settlement (FR-5.2, FR-5.3, FR-8)', () => {
    it('requires an on-chain commitment before a hand can open (FR-6)', async () => {
      await seatAll();
      const handId = handIdOf('uncommitted');
      await expect(poker.connect(stack.operator).openHand(TABLE_ID, handId, SEATS))
        .to.be.revertedWithCustomError(poker, 'ShuffleNotRevealed')
        .withArgs(handId);
    });

    it('only lets the operator open, contribute and settle (FR-10.3)', async () => {
      await seatAll();
      const handId = handIdOf('operator-only');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('seed'));
      await commitHand(stack, handId, seed, 1n);

      await expect(poker.connect(stack.players[0]!).openHand(TABLE_ID, handId, SEATS))
        .to.be.revertedWithCustomError(poker, 'NotOperator')
        .withArgs(stack.playerAddresses[0]!);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, SEATS);
      await expect(poker.connect(stack.players[0]!).commitHand(TABLE_ID, handId, 0, 1n))
        .to.be.revertedWithCustomError(poker, 'NotOperator');
      await revealHand(stack, handId, seed);
      await expect(
        poker.connect(stack.players[0]!).settleHand(TABLE_ID, handId, [], [0], [0n], true),
      ).to.be.revertedWithCustomError(poker, 'NotOperator');
    });

    it('records contributions and settles with balances moving exactly as expected', async () => {
      const seats = [0, 1, 2];
      await seatAll(seats);
      const handId = handIdOf('exact-movement');
      const contributions = [ethers.parseEther('10'), ethers.parseEther('20'), ethers.parseEther('5')];
      // Seat 2 wins the whole pot minus rake.
      const { pot, rake, award } = await playHand(handId, { seats, contributions, winner: 2 });

      expect(pot).to.equal(ethers.parseEther('35'));
      expect(rake).to.equal(RAKE.cap); // 250 bps of 35 = 0.875, capped at 0.05
      expect(award).to.equal(pot - rake);

      // Escrow: contributers debited, the winner credited the award.
      expect(await poker.escrowBalanceOf(TABLE_ID, 0)).to.equal(LEGAL_BUY_IN - contributions[0]!);
      expect(await poker.escrowBalanceOf(TABLE_ID, 1)).to.equal(LEGAL_BUY_IN - contributions[1]!);
      expect(await poker.escrowBalanceOf(TABLE_ID, 2)).to.equal(LEGAL_BUY_IN - contributions[2]! + award);

      // Conservation: escrow + rake == the tokens the contract actually holds.
      const totalEscrow =
        (await poker.escrowBalanceOf(TABLE_ID, 0)) +
        (await poker.escrowBalanceOf(TABLE_ID, 1)) +
        (await poker.escrowBalanceOf(TABLE_ID, 2));
      expect(await stack.token.balanceOf(stack.pokerAddress)).to.equal(totalEscrow + rake);
      expect(totalEscrow).to.equal(LEGAL_BUY_IN * 3n - rake);

      // Rake left escrow into the splitter (FR-8.2) and was split 50/50.
      expect(await stack.token.balanceOf(stack.splitterAddress)).to.equal(rake);
      expect(await stack.splitter.pendingStaking()).to.equal(rake / 2n);
      expect(await stack.splitter.pendingVault()).to.equal(rake / 2n);
      expect(await poker.pendingHandsOf(TABLE_ID)).to.equal(0n);
    });

    it('emits HandSettled with the full pot/rake/award breakdown (FR-5.2, FR-8.2)', async () => {
      const seats = [0, 1, 2, 3];
      await seatAll(seats);
      const handId = handIdOf('event');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('event-seed'));
      await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      const contributions = seats.map(() => ethers.parseEther('10'));
      for (const [index, seat] of seats.entries()) {
        await poker.connect(stack.operator).commitHand(TABLE_ID, handId, seat, contributions[index]!);
      }
      await revealHand(stack, handId, seed);

      const pot = ethers.parseEther('40');
      const rake = RAKE.cap;
      await expect(poker.connect(stack.operator).settleHand(TABLE_ID, handId, contributions, [1], [pot - rake], true))
        .to.emit(poker, 'HandSettled')
        .withArgs(TABLE_ID, handId, pot, rake, 1n, [1], [pot - rake]);
    });

    it('takes no rake when no flop was seen (FR-8.1)', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('no-flop');
      const contributions = [ethers.parseEther('20'), ethers.parseEther('20')];
      const { pot, rake, award } = await playHand(handId, { seats, contributions, winner: 0, sawFlop: false });

      expect(rake).to.equal(0n);
      expect(award).to.equal(pot);
      expect(await stack.token.balanceOf(stack.splitterAddress)).to.equal(0n);
      expect(await poker.escrowBalanceOf(TABLE_ID, 0)).to.equal(LEGAL_BUY_IN + pot);
    });

    it('honours the rake cap, not just the bps (FR-8.1)', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('rake-cap');
      const contributions = [ethers.parseEther('20'), ethers.parseEther('20')];
      await playHand(handId, { seats, contributions, winner: 0 });

      // 250 bps of 40 = 1.0 token would be charged, but the cap is 0.05.
      expect(await stack.token.balanceOf(stack.splitterAddress)).to.equal(RAKE.cap);
      expect(await stack.splitter.pendingStaking()).to.equal(RAKE.cap / 2n);
    });

    it('rejects a settlement whose contributions do not match what was committed', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('bad-contributions');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('bad-seed'));
      await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('20'));
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 1, ethers.parseEther('20'));
      await revealHand(stack, handId, seed);

      // Under-declared pot.
      await expect(
        poker
          .connect(stack.operator)
          .settleHand(TABLE_ID, handId, [ethers.parseEther('20'), ethers.parseEther('19')], [0], [ethers.parseEther('39')], true),
      ).to.be.revertedWithCustomError(poker, 'ContributionMismatch');
      // Declared pot larger than the sum of contributions.
      await expect(
        poker
          .connect(stack.operator)
          .settleHand(TABLE_ID, handId, [ethers.parseEther('20'), 0n], [0], [ethers.parseEther('20')], true),
      ).to.be.revertedWithCustomError(poker, 'ContributionMismatch');
    });

    it('rejects awards that do not equal pot minus rake', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('bad-awards');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('bad-awards-seed'));
      const contributions = [ethers.parseEther('20'), ethers.parseEther('20')];
      await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      for (const [index, seat] of seats.entries()) {
        await poker.connect(stack.operator).commitHand(TABLE_ID, handId, seat, contributions[index]!);
      }
      await revealHand(stack, handId, seed);

      const expected = ethers.parseEther('40') - RAKE.cap;
      await expect(
        poker.connect(stack.operator).settleHand(TABLE_ID, handId, contributions, [0], [expected + 1n], true),
      )
        .to.be.revertedWithCustomError(poker, 'AwardsMismatch')
        .withArgs(expected, expected + 1n);
    });

    it('rejects a settlement of a hand whose shuffle was never revealed', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('unrevealed');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('unrevealed-seed'));
      await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('20'));

      await expect(
        poker.connect(stack.operator).settleHand(TABLE_ID, handId, [ethers.parseEther('20'), 0n], [0], [ethers.parseEther('20')], true),
      )
        .to.be.revertedWithCustomError(poker, 'ShuffleNotRevealed')
        .withArgs(handId);
    });

    it('rejects double settlement of the same hand id', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('double-settle');
      const { pot, rake } = await playHand(handId, {
        seats,
        contributions: [ethers.parseEther('20'), ethers.parseEther('20')],
        winner: 0,
      });

      await expect(
        poker
          .connect(stack.operator)
          .settleHand(TABLE_ID, handId, [ethers.parseEther('20'), ethers.parseEther('20')], [0], [pot - rake], true),
      )
        .to.be.revertedWithCustomError(poker, 'HandNotOpen')
        .withArgs(handId, 2n); // HandStatus.Settled
    });

    it('rejects an unknown hand and bad seat indexes', async () => {
      await seatAll();
      const unknown = handIdOf('unknown-hand');
      await expect(
        poker.connect(stack.operator).settleHand(TABLE_ID, unknown, [], [0], [0n], true),
      ).to.be.revertedWithCustomError(poker, 'UnknownHand');
      await expect(poker.connect(stack.operator).openHand(TABLE_ID, unknown, [0])).to.be.revertedWithCustomError(
        poker,
        'InvalidSeat',
      );
      await expect(
        poker.connect(stack.operator).openHand(TABLE_ID, unknown, [0, 0, 1, 2, 3, 4, 5]),
      ).to.be.revertedWithCustomError(poker, 'InvalidSeat');
    });

    it('blocks a seat from appearing twice in one hand (double-commit guard)', async () => {
      await seatAll([0, 1]);
      const handId = handIdOf('dup-seat');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('dup-seed'));
      await commitHand(stack, handId, seed, 1n);
      await expect(poker.connect(stack.operator).openHand(TABLE_ID, handId, [0, 0]))
        .to.be.revertedWithCustomError(poker, 'HandPending')
        .withArgs(handId);
    });

    it('blocks opening a hand for an unseated seat', async () => {
      await seatAll([0, 1]);
      const handId = handIdOf('unseated');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('unseated-seed'));
      await commitHand(stack, handId, seed, 1n);
      await expect(poker.connect(stack.operator).openHand(TABLE_ID, handId, [0, 4]))
        .to.be.revertedWithCustomError(poker, 'NoPosition');
    });

    it('locks escrow while a hand is open and releases it after settlement (FR-5.5)', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('lock');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('lock-seed'));
      await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('20'));

      await expect(poker.connect(stack.players[0]!).cashOut(TABLE_ID, 0))
        .to.be.revertedWithCustomError(poker, 'HandPending')
        .withArgs(handId);

      await revealHand(stack, handId, seed);
      await poker
        .connect(stack.operator)
        .settleHand(TABLE_ID, handId, [ethers.parseEther('20'), 0n], [1], [ethers.parseEther('20') - RAKE.cap], true);

      // Settlement unlocks the seat.
      await expect(poker.connect(stack.players[0]!).cashOut(TABLE_ID, 0)).to.not.be.reverted;
    });

    it('ignores trailing zero contributions so fixed-size arrays are usable', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('trailing-zeros');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('trailing-seed'));
      await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      const contributions = [ethers.parseEther('20'), ethers.parseEther('20')];
      for (const [index, seat] of seats.entries()) {
        await poker.connect(stack.operator).commitHand(TABLE_ID, handId, seat, contributions[index]!);
      }
      await revealHand(stack, handId, seed);

      // Six entries for a two-seat hand: the extra four are zero.
      const padded = [...contributions, 0n, 0n, 0n, 0n];
      await expect(
        poker
          .connect(stack.operator)
          .settleHand(TABLE_ID, handId, padded, [0], [ethers.parseEther('40') - RAKE.cap], true),
      ).to.not.be.reverted;
    });

    it('refuses a contribution larger than the seat escrow', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('over-escrow');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('over-escrow-seed'));
      await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('21'));
      await revealHand(stack, handId, seed);

      await expect(
        poker
          .connect(stack.operator)
          .settleHand(TABLE_ID, handId, [ethers.parseEther('21'), 0n], [0], [ethers.parseEther('21')], true),
      )
        .to.be.revertedWithCustomError(poker, 'ContributionExceedsEscrow')
        .withArgs(0, ethers.parseEther('21'), LEGAL_BUY_IN);
    });

    it('supports a split pot across several winners', async () => {
      const seats = [0, 1, 2];
      await seatAll(seats);
      const handId = handIdOf('split-pot');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('split-seed'));
      const contributions = seats.map(() => ethers.parseEther('20'));
      await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      for (const [index, seat] of seats.entries()) {
        await poker.connect(stack.operator).commitHand(TABLE_ID, handId, seat, contributions[index]!);
      }
      await revealHand(stack, handId, seed);

      const pot = ethers.parseEther('60');
      const rake = RAKE.cap;
      const share = (pot - rake) / 2n;
      const remainder = pot - rake - share * 2n;
      // Odd chip rule (FR-3.4): the remainder is awarded explicitly, not implicitly.
      await poker
        .connect(stack.operator)
        .settleHand(TABLE_ID, handId, contributions, [0, 1], [share + remainder, share], true);

      expect(await poker.escrowBalanceOf(TABLE_ID, 0)).to.equal(LEGAL_BUY_IN - contributions[0]! + share + remainder);
      expect(await poker.escrowBalanceOf(TABLE_ID, 1)).to.equal(LEGAL_BUY_IN - contributions[1]! + share);
      expect(await poker.escrowBalanceOf(TABLE_ID, 2)).to.equal(LEGAL_BUY_IN - contributions[2]!);
    });

    it('is O(seats): two concurrent hands at the same table stay independent', async () => {
      await seatAll();
      const first = handIdOf('concurrent-a');
      const second = handIdOf('concurrent-b');
      const seedA = ethers.keccak256(ethers.toUtf8Bytes('a'));
      const seedB = ethers.keccak256(ethers.toUtf8Bytes('b'));
      await commitHand(stack, first, seedA, 1n);
      await commitHand(stack, second, seedB, 1n);

      await poker.connect(stack.operator).openHand(TABLE_ID, first, [0, 1]);
      await expect(poker.connect(stack.operator).openHand(TABLE_ID, second, [1, 2]))
        .to.be.revertedWithCustomError(poker, 'HandPending')
        .withArgs(first);
      await expect(poker.connect(stack.operator).openHand(TABLE_ID, second, [2, 3])).to.not.be.reverted;
      expect(await poker.pendingHandsOf(TABLE_ID)).to.equal(2n);
    });
  });

  describe('void / reorg refund path (FR-5.6, FR-6.6, NFR-6)', () => {
    it('cannot be voided while the shuffle is still pending', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('void-pending');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('void-pending-seed'));
      await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('20'));

      await expect(poker.connect(stack.players[0]!).voidHand(TABLE_ID, handId))
        .to.be.revertedWithCustomError(poker, 'ShuffleStillPending')
        .withArgs(handId);
    });

    it('restores every contribution to escrow when the shuffle voids (FR-6.6)', async () => {
      const seats = [0, 1, 2];
      await seatAll(seats);
      const handId = handIdOf('void-restores');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('void-restores-seed'));
      const contributions = [ethers.parseEther('20'), ethers.parseEther('15'), ethers.parseEther('10')];
      const { commitBlock } = await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      for (const [index, seat] of seats.entries()) {
        await poker.connect(stack.operator).commitHand(TABLE_ID, handId, seat, contributions[index]!);
      }
      const pot = contributions.reduce((a, b) => a + b, 0n);
      expect(await poker.escrowBalanceOf(TABLE_ID, 0)).to.equal(LEGAL_BUY_IN); // not debited until settlement

      // The reveal window expires and anyone voids the shuffle (FR-6.6).
      await mineUpTo(BigInt(commitBlock) + 257n);
      await stack.shuffle.connect(stack.players[3]!).void(handId);

      await expect(poker.connect(stack.players[3]!).voidHand(TABLE_ID, handId))
        .to.emit(poker, 'HandVoided')
        .withArgs(TABLE_ID, handId, pot, ethers.encodeBytes32String('SHUFFLE_VOIDED'));

      for (const seat of seats) {
        expect(await poker.escrowBalanceOf(TABLE_ID, seat)).to.equal(LEGAL_BUY_IN);
      }
      expect(await poker.pendingHandsOf(TABLE_ID)).to.equal(0n);
      // Escrow is spendable again.
      await expect(poker.connect(stack.players[0]!).cashOut(TABLE_ID, 0)).to.not.be.reverted;
    });

    it('refuses to settle a hand whose shuffle voided', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('void-then-settle');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('void-then-settle-seed'));
      const { commitBlock } = await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('20'));
      await mineUpTo(BigInt(commitBlock) + 257n);
      await stack.shuffle.connect(stack.players[2]!).void(handId);

      await expect(
        poker.connect(stack.operator).settleHand(TABLE_ID, handId, [ethers.parseEther('20'), 0n], [0], [ethers.parseEther('20')], true),
      )
        .to.be.revertedWithCustomError(poker, 'ShuffleVoided')
        .withArgs(handId);

      await expect(poker.connect(stack.players[0]!).voidHand(TABLE_ID, handId)).to.not.be.reverted;
      await expect(poker.connect(stack.players[0]!).voidHand(TABLE_ID, handId)).to.be.revertedWithCustomError(
        poker,
        'HandNotOpen',
      );
    });

    it('lets the owner void a hand whose anchor block was orphaned (FR-5.6, NFR-6)', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('reorg');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('reorg-seed'));
      const { commitBlock } = await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('20'));

      // Before the window expires the anchor is not invalid yet.
      await expect(poker.connect(stack.owner).voidInvalidAnchor(TABLE_ID, handId))
        .to.be.revertedWithCustomError(poker, 'ShuffleStillPending');

      await mineUpTo(BigInt(commitBlock) + 257n);
      await expect(poker.connect(stack.players[0]!).voidInvalidAnchor(TABLE_ID, handId)).to.be.revertedWithCustomError(
        poker,
        'OwnableUnauthorizedAccount',
      );
      await expect(poker.connect(stack.owner).voidInvalidAnchor(TABLE_ID, handId))
        .to.emit(poker, 'HandVoided')
        .withArgs(TABLE_ID, handId, ethers.parseEther('20'), ethers.encodeBytes32String('ANCHOR_INVALID'));

      expect(await poker.escrowBalanceOf(TABLE_ID, 0)).to.equal(LEGAL_BUY_IN);
      expect(await poker.pendingHandsOf(TABLE_ID)).to.equal(0n);

      // The reveal is still impossible, so the hand can never be settled afterwards.
      await expect(stack.shuffle.connect(stack.operator).reveal(handId, seed)).to.be.revertedWithCustomError(
        stack.shuffle,
        'OutsideRevealWindow',
      );
      await expect(
        poker.connect(stack.operator).settleHand(TABLE_ID, handId, [ethers.parseEther('20'), 0n], [0], [ethers.parseEther('20')], true),
      ).to.be.revertedWithCustomError(poker, 'HandNotOpen');
    });

    it('cannot void a hand that was already settled', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      const handId = handIdOf('void-settled');
      await playHand(handId, {
        seats,
        contributions: [ethers.parseEther('20'), ethers.parseEther('20')],
        winner: 0,
      });
      await expect(poker.connect(stack.players[0]!).voidHand(TABLE_ID, handId))
        .to.be.revertedWithCustomError(poker, 'HandNotOpen')
        .withArgs(handId, 2n);
    });
  });

  describe('emergency pause (FR-10.5)', () => {
    it('halts deposits and settlement but never cash-out', async () => {
      const seats = [0, 1];
      await seatAll(seats);
      await poker.connect(stack.owner).pause();
      expect(await poker.paused()).to.equal(true);

      // Deposits are part of the wager flow and are blocked...
      await expect(poker.connect(stack.players[2]!).deposit(TABLE_ID, 2, LEGAL_BUY_IN)).to.be.revertedWithCustomError(
        poker,
        'EnforcedPause',
      );
      // ...settlement is blocked...
      const handId = handIdOf('paused');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('paused-seed'));
      await commitHand(stack, handId, seed, 1n);
      await expect(poker.connect(stack.operator).openHand(TABLE_ID, handId, seats)).to.be.reverted;
      await poker.connect(stack.owner).unpause();
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('20'));
      await revealHand(stack, handId, seed);
      await poker.connect(stack.owner).pause();
      await expect(
        poker.connect(stack.operator).settleHand(TABLE_ID, handId, [ethers.parseEther('20'), 0n], [0], [ethers.parseEther('20') - RAKE.cap], true),
      ).to.be.revertedWithCustomError(poker, 'EnforcedPause');

      // ...but already-settled escrow must always be withdrawable.
      await poker.connect(stack.owner).unpause();
      await poker
        .connect(stack.operator)
        .settleHand(TABLE_ID, handId, [ethers.parseEther('20'), 0n], [1], [ethers.parseEther('20') - RAKE.cap], true);
      await poker.connect(stack.owner).pause();
      await expect(poker.connect(stack.players[1]!).cashOut(TABLE_ID, 1)).to.not.be.reverted;
      await expect(poker.connect(stack.players[0]!).cashOut(TABLE_ID, 0)).to.not.be.reverted;
    });

    it('only lets the owner pause and unpause', async () => {
      await expect(poker.connect(stack.operator).pause()).to.be.revertedWithCustomError(
        poker,
        'OwnableUnauthorizedAccount',
      );
      await poker.connect(stack.owner).pause();
      await expect(poker.connect(stack.players[0]!).unpause()).to.be.revertedWithCustomError(
        poker,
        'OwnableUnauthorizedAccount',
      );
    });

    it('has no on-chain switch for free mode (FR-4.1, FR-10.5)', async () => {
      // The contract exposes no free-mode entry point at all: free tables never touch the chain.
      const functions = poker.interface.fragments.filter((f: any) => f.type === 'function').map((f: any) => f.name);
      expect(functions.some((name: string) => /free/i.test(name))).to.equal(false);
    });
  });

  describe('constructor guards and views', () => {
    it('rejects zero addresses', async () => {
      const factory = await hre.ethers.getContractFactory('Poker', stack.owner);
      await expect(
        factory.deploy(
          ethers.ZeroAddress,
          stack.shuffleAddress,
          stack.splitterAddress,
          stack.ownerAddress,
          stack.operatorAddress,
        ),
      ).to.be.revertedWithCustomError(factory, 'ZeroAddress');
      await expect(
        factory.deploy(
          stack.tokenAddress,
          stack.shuffleAddress,
          stack.splitterAddress,
          stack.ownerAddress,
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(factory, 'ZeroAddress');
    });

    it('derives the seat key exactly like keccak256(tableId, seat)', async () => {
      await poker.connect(stack.players[0]!).deposit(TABLE_ID, 3, LEGAL_BUY_IN);
      expect(await poker.escrowOf(seatKey(TABLE_ID, 3))).to.equal(LEGAL_BUY_IN);
      expect(await poker.escrowBalanceOf(TABLE_ID, 3)).to.equal(LEGAL_BUY_IN);
    });

    it('reports hand info for verifiers (NFR-4)', async () => {
      const seats = [0, 1, 2];
      await seatAll(seats);
      const handId = handIdOf('verifier-info');
      const seed = ethers.keccak256(ethers.toUtf8Bytes('verifier-seed'));
      await commitHand(stack, handId, seed, 1n);
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);
      const [status, pot, seatCount, participants] = await poker.handInfoOf(TABLE_ID, handId);
      expect(status).to.equal(1n); // Open
      expect(pot).to.equal(0n);
      expect(seatCount).to.equal(3n);
      expect(participants.slice(0, 3)).to.deep.equal([0n, 1n, 2n]);
      // `totalEscrowObserved` makes the solvency claim checkable by anyone.
      expect(await poker.totalEscrowObserved()).to.equal(await stack.token.balanceOf(stack.pokerAddress));
    });
  });
});
