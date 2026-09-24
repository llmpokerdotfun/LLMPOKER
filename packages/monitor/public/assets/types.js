/**
 * JSDoc mirror of the frozen wire types in `packages/shared/src/types.ts`.
 *
 * The monitor is dependency-free plain browser JavaScript, so it cannot import
 * the TypeScript source for types. This file repeats the *wire* shapes that the
 * pages consume, which lets `tsc --checkJs` catch a typo in a field name
 * instead of silently rendering `undefined`.
 *
 * Keep this file in sync with `packages/shared/src/types.ts`; it contains no
 * runtime code.
 *
 * FR-6 (patched) is encoded in {@link RngProof}: while a hand is live the seed,
 * the entropy, the salts and the deck ordering are secret — `proof.deck` is an
 * **empty array by design**, not missing data. Only per-card {@link CardReveal}
 * entries carry card values before the phase-4 audit.
 */

/** @typedef {string} ChipsJson Decimal string of chip base units (1 token = 1e18). */
/** @typedef {'FREE'|'WAGER'} Mode */
/** @typedef {'PREFLOP'|'FLOP'|'TURN'|'RIVER'|'SHOWDOWN'|'COMPLETE'} Street */
/** @typedef {'FOLD'|'CHECK'|'CALL'|'BET'|'RAISE'|'ALL_IN'} ActionType */
/** @typedef {'AGENT'|'TIMEOUT'|'ENGINE'} ActionOrigin */
/** @typedef {'IDLE'|'SEATED'|'THINKING'|'FOLDED'|'BUSTED'|'OFFLINE'} AgentStatus */
/** @typedef {'OPEN'|'RUNNING'|'PAUSED'|'CLOSED'} TableStatus */
/** @typedef {'EMPTY'|'SITTING_OUT'|'ACTIVE'|'FOLDED'|'ALL_IN'|'BUSTED'} SeatStatus */
/** @typedef {'HIGH_CARD'|'PAIR'|'TWO_PAIR'|'TRIPS'|'STRAIGHT'|'FLUSH'|'FULL_HOUSE'|'QUADS'|'STRAIGHT_FLUSH'|'ROYAL_FLUSH'} HandCategory */

/** FR-6 lifecycle of one verifiable-RNG hand, mirroring `IShuffle.Phase`. */
/** @typedef {'NONE'|'SEED_COMMITTED'|'DECK_COMMITTED'|'AUDITED'|'VOIDED'} RngPhase */

/** FR-6.7 liveness: why a hand was voided instead of audited. */
/** @typedef {'NO_DECK_COMMITMENT'|'AUDIT_STALLED'|'AUDIT_FAILED'} RngVoidReason */

/**
 * @typedef {Object} TableConfig
 * @property {string} id
 * @property {string} name
 * @property {Mode} mode
 * @property {number} maxSeats
 * @property {ChipsJson} smallBlind
 * @property {ChipsJson} bigBlind
 * @property {ChipsJson} ante
 * @property {ChipsJson} minBuyIn
 * @property {ChipsJson} maxBuyIn
 * @property {number} thinkBudgetMs
 * @property {number} rakeBps
 * @property {ChipsJson} rakeCap
 * @property {boolean} rakeOnlyWithFlop
 * @property {boolean} burnCards
 * @property {boolean} autoStart
 * @property {number} handIntervalMs
 * @property {boolean} escrowRequired
 */

/**
 * @typedef {Object} SeatSnapshot
 * @property {number} seat
 * @property {SeatStatus} status
 * @property {string|null} agentId
 * @property {string|null} agentName
 * @property {ChipsJson} stack
 * @property {ChipsJson} committed
 * @property {ChipsJson} totalCommitted
 * @property {number[]|null} holeCards `null` while hidden (FR-6: never sent mid-hand)
 * @property {ChipsJson|null} escrow
 */

/**
 * @typedef {Object} PotSnapshot
 * @property {number} index
 * @property {ChipsJson} amount
 * @property {number[]} eligibleSeats
 */

/**
 * @typedef {Object} TableSnapshot
 * @property {string} id
 * @property {string} name
 * @property {Mode} mode
 * @property {TableStatus} status
 * @property {TableConfig} config
 * @property {SeatSnapshot[]} seats
 * @property {number|null} buttonSeat
 * @property {string|null} handId
 * @property {number} handNumber
 * @property {Street|null} street
 * @property {number[]} board
 * @property {PotSnapshot[]} pots
 * @property {ChipsJson} totalPot
 * @property {ChipsJson} currentBet
 * @property {ChipsJson} minRaiseTo
 * @property {number|null} toActSeat
 * @property {number|null} actionDeadlineTs
 * @property {string|null} rngCommitment FR-6.1 phase-1 seed commitment for the in-flight hand.
 * @property {string|null} rngDeckRoot FR-6.2 phase-2 Merkle root of the salted deck.
 * @property {RngPhase} rngPhase how far the FR-6 lifecycle has progressed for the in-flight hand.
 * @property {number} startedAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} AgentMetadata
 * @property {string} [model]
 * @property {string} [endpoint]
 * @property {string} [avatar]
 * @property {string} [description]
 * @property {string} [operator]
 */

/**
 * @typedef {Object} AgentSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} wallet
 * @property {AgentMetadata} metadata
 * @property {number} createdAt
 * @property {number|null} lastSeenAt
 * @property {boolean} sharedWallet
 * @property {AgentStatus} status
 * @property {{tableId: string, seat: number}|null} seatedAt
 * @property {ChipsJson|null} stack
 * @property {number} handsPlayed
 * @property {number} handsWon
 * @property {ChipsJson} freeChips
 * @property {ChipsJson} escrow
 * @property {ChipsJson} netWagerProfit
 */

/**
 * One card the game rules made public, with its Merkle path (FR-6.3).
 *
 * @typedef {Object} CardReveal
 * @property {number} index position in the shuffled deck, `0..51`
 * @property {number} card card id `0..51`
 * @property {string} salt 0x-prefixed 32-byte salt
 * @property {string[]} proof 6 sibling hashes, leaf level first
 */

/**
 * Everything a verifier needs about one hand's shuffle (FR-6, patched).
 *
 * While `phase` is `SEED_COMMITTED` or `DECK_COMMITTED`, `deckSeed`, `entropy`
 * and `salts` are `null` and `deck` is empty; only `reveals` may carry card
 * values. After the hand, `phase` is `AUDITED` and the full `deck`, `salts`,
 * `deckSeed` and `entropy` are published so the commitment is provable forever.
 *
 * @typedef {Object} RngProof
 * @property {string} handId
 * @property {string} tableId
 * @property {number} handNumber
 * @property {RngPhase} phase
 * @property {string} commitment FR-6.1: keccak256(abi.encodePacked(deckSeed, nonce))
 * @property {string} nonce per-table uint256, decimal
 * @property {number|null} commitBlock block N
 * @property {string|null} commitTxHash
 * @property {number|null} anchorBlock block N+1
 * @property {string|null} anchorBlockHash hash of block N+1
 * @property {string|null} deckRoot FR-6.2: Merkle root over leaf_i = keccak256(card_i ‖ salt_i)
 * @property {number|null} deckRootBlock block M
 * @property {string|null} deckRootTxHash
 * @property {CardReveal[]} reveals FR-6.3: only what the rules made public
 * @property {boolean} audited FR-6.4: the end-of-hand audit passed
 * @property {string|null} deckSeed null while live; published with the audit
 * @property {string|null} entropy null while live; published with the audit
 * @property {string[]|null} salts 52 salts, published with the audit
 * @property {number[]} deck the 52-card ordering: EMPTY while the hand is live
 * @property {number|null} auditBlock
 * @property {string|null} auditTxHash
 * @property {string|null} slashed bond slashed because the audit proved a cheat (FR-6.5)
 * @property {RngVoidReason|null} voidedReason FR-6.7 liveness
 * @property {'ONCHAIN'|'LOCAL'} anchorSource
 * @property {number} requiredConfirmations confirmations required over the anchor (FR-6.5)
 * @property {boolean} verified server-stored verdict flag
 * @property {number|null} verifiedAt
 * @property {number} chainId 4663 = Robinhood Chain
 */

/**
 * @typedef {Object} ProofCheck
 * @property {string} name
 * @property {boolean} ok
 * @property {string} [detail]
 */

/**
 * @typedef {Object} ProofVerification
 * @property {boolean} ok
 * @property {ProofCheck[]} checks
 */

/**
 * @typedef {Object} ActionRecord
 * @property {number} seq
 * @property {string} handId
 * @property {Street} street
 * @property {number} seat
 * @property {ActionType} action
 * @property {ChipsJson} amount
 * @property {ActionOrigin} origin
 * @property {ChipsJson} paid
 * @property {ChipsJson} potAfter
 * @property {number} at
 */

/**
 * @typedef {Object} RevealedHand
 * @property {number} seat
 * @property {number[]} cards
 * @property {HandCategory|null} category
 * @property {string|null} description
 */

/**
 * @typedef {Object} PotAward
 * @property {number} potIndex
 * @property {ChipsJson} amount
 * @property {ChipsJson} rake
 * @property {{seat: number, amount: ChipsJson}[]} winners
 * @property {number|null} [oddChipSeat]
 */

/**
 * @typedef {Object} HandSeatResult
 * @property {number} seat
 * @property {string|null} agentId
 * @property {ChipsJson} startingStack
 * @property {ChipsJson} endingStack
 * @property {ChipsJson} net
 * @property {number[]|null} holeCards
 * @property {boolean} folded
 * @property {boolean} allIn
 */

/**
 * @typedef {Object} HandResult
 * @property {string} handId
 * @property {string} tableId
 * @property {number} handNumber
 * @property {Mode} mode
 * @property {Street} streetReached
 * @property {number[]} board
 * @property {number} startedAt
 * @property {number} endedAt
 * @property {number} buttonSeat
 * @property {number[]} dealingOrder
 * @property {number[]} burns
 * @property {HandSeatResult[]} seats
 * @property {ActionRecord[]} actions
 * @property {PotAward[]} pots
 * @property {ChipsJson} totalPot
 * @property {ChipsJson} totalRake
 * @property {RevealedHand[]} showdown
 * @property {boolean} zeroSumVerified
 */

/**
 * @typedef {Object} HandHistory
 * @property {HandResult} result
 * @property {RngProof} proof
 * @property {number[]} deck top-level copy of the audited ordering; empty while live
 * @property {TableConfig|null} [config]
 */

/**
 * @typedef {Object} HandSummary
 * @property {string} handId
 * @property {string} tableId
 * @property {string} tableName
 * @property {number} handNumber
 * @property {Mode} mode
 * @property {number} startedAt
 * @property {number} endedAt
 * @property {Street} streetReached
 * @property {number[]} board
 * @property {ChipsJson} totalPot
 * @property {ChipsJson} totalRake
 * @property {number} playerCount
 * @property {{seat: number, name: string|null, amount: ChipsJson}[]} winners
 * @property {string} commitment
 * @property {number|null} commitBlock
 * @property {number|null} anchorBlock
 * @property {boolean} proofVerified
 * @property {string|null} deckRoot FR-6.2: the committed deck root for this hand
 * @property {boolean} audited FR-6.4: the end-of-hand audit passed
 * @property {boolean} [fromLive] Locally derived from a WS delta, not from `/api/v1/hands`.
 * @property {TableConfig|null} [config] The row's table config, when the caller has it. The
 *   authoritative `/api/v1/hands` summary does not carry it; a row built from a live delta and
 *   the `HandHistory` detail do. Money render sites read it through
 *   `format.tableMoney()` so a free row's pot is whole play chips and a wager row keeps its
 *   settlement currency's decimals.
 */

/**
 * @typedef {Object} LeaderboardRow
 * @property {string} agentId
 * @property {string} name
 * @property {Mode} mode
 * @property {number} handsPlayed
 * @property {number} handsWon
 * @property {number} winRate
 * @property {ChipsJson} netProfit
 * @property {ChipsJson} volume
 */

/**
 * @typedef {Object} LegalActions
 * @property {boolean} canFold
 * @property {boolean} canCheck
 * @property {boolean} canCall
 * @property {boolean} canBet
 * @property {boolean} canRaise
 * @property {boolean} canAllIn
 * @property {ChipsJson} toCall
 * @property {ChipsJson} minRaiseTo
 * @property {ChipsJson} maxRaiseTo
 * @property {ChipsJson[]} sizedTargets
 */

/**
 * @typedef {Object} ActionRequest
 * @property {string} tableId
 * @property {string} handId
 * @property {number} seat
 * @property {Street} street
 * @property {LegalActions} legal
 * @property {ChipsJson} pot
 * @property {number[]} board
 * @property {number[]} holeCards
 * @property {ChipsJson} stack
 * @property {number} deadlineTs
 */

// ---------------------------------------------------------------------------
// Table events — the delta vocabulary on /api/v1/ws (FR-6.1, FR-6.2, FR-6.3, FR-6.4)
// ---------------------------------------------------------------------------

/** @typedef {'HAND_STARTED'|'BLIND_POSTED'|'HOLE_CARDS_DEALT'|'ACTION_REQUIRED'|'ACTION_TAKEN'|'STREET_ADVANCED'|'SHOWDOWN'|'POT_AWARDED'|'HAND_COMPLETE'|'RNG_SEED_COMMITTED'|'RNG_DECK_COMMITTED'|'CARD_REVEALED'|'RNG_AUDITED'|'RNG_VOIDED'|'SEAT_CHANGED'|'TABLE_STATE'} TableEventType */

/** @typedef {{type: 'HAND_STARTED', handId: string, handNumber: number, buttonSeat: number, blinds: {sb: number, bb: number}, ante: ChipsJson}} HandStartedEvent */
/** @typedef {{type: 'BLIND_POSTED', seat: number, amount: ChipsJson, kind: 'SMALL_BLIND'|'BIG_BLIND'|'ANTE'}} BlindPostedEvent */
/** @typedef {{type: 'HOLE_CARDS_DEALT', seat: number}} HoleCardsDealtEvent */
/** @typedef {{type: 'ACTION_REQUIRED', seat: number, request: ActionRequest}} ActionRequiredEvent */
/** @typedef {{type: 'ACTION_TAKEN', record: ActionRecord}} ActionTakenEvent */
/** @typedef {{type: 'STREET_ADVANCED', street: Street, board: number[], burns: number}} StreetAdvancedEvent */
/** @typedef {{type: 'SHOWDOWN', reveals: RevealedHand[]}} ShowdownEvent */
/** @typedef {{type: 'POT_AWARDED', award: PotAward}} PotAwardedEvent */
/** @typedef {{type: 'HAND_COMPLETE', result: HandResult}} HandCompleteEvent */
/** @typedef {{type: 'RNG_SEED_COMMITTED', commitment: string, nonce: string, commitBlock: number|null}} RngSeedCommittedEvent */
/** @typedef {{type: 'RNG_DECK_COMMITTED', deckRoot: string, deckRootBlock: number|null, anchorBlock: number|null}} RngDeckCommittedEvent */
/** @typedef {{type: 'CARD_REVEALED', reveal: CardReveal}} CardRevealedEvent */
/** @typedef {{type: 'RNG_AUDITED', proof: RngProof}} RngAuditedEvent */
/** @typedef {{type: 'RNG_VOIDED', reason: RngVoidReason}} RngVoidedEvent */
/** @typedef {{type: 'SEAT_CHANGED', seat: number, status: SeatStatus, stack: ChipsJson}} SeatChangedEvent */
/** @typedef {{type: 'TABLE_STATE', table: TableSnapshot}} TableStateEvent */

/**
 * The frozen table-event union. The two FR-6 event names of the *old* scheme
 * (`RNG_COMMITTED`, `RNG_REVEALED`) no longer exist.
 *
 * @typedef {HandStartedEvent|BlindPostedEvent|HoleCardsDealtEvent|ActionRequiredEvent|ActionTakenEvent|StreetAdvancedEvent|ShowdownEvent|PotAwardedEvent|HandCompleteEvent|RngSeedCommittedEvent|RngDeckCommittedEvent|CardRevealedEvent|RngAuditedEvent|RngVoidedEvent|SeatChangedEvent|TableStateEvent} TableEvent
 */

/**
 * @typedef {Object} TableEventEnvelope
 * @property {number} seq
 * @property {number} at
 * @property {string} tableId
 * @property {TableEvent} payload
 */

/**
 * @typedef {Object} MonitorEvent
 * @property {'AGENT_UPDATED'|'TABLE_UPDATED'|'TABLE_EVENT'|'HAND_COMPLETE'} kind
 * @property {AgentSnapshot} [agent]
 * @property {TableSnapshot} [table]
 * @property {string} [tableId]
 * @property {TableEventEnvelope} [envelope]
 * @property {string} [handId]
 * @property {HandResult} [result]
 */

/**
 * Wire envelope from `/api/v1/ws`. Only the monitor-relevant variants are typed
 * here; the table-scoped agent/table variants are optional extras the monitor
 * accepts when they arrive.
 *
 * @typedef {Object} ServerMessage
 * @property {string} type
 * @property {number} [serverTime]
 * @property {number} [chainId]
 * @property {string} [version]
 * @property {AgentSnapshot[]} [agents]
 * @property {TableSnapshot[]} [tables]
 * @property {AgentSnapshot} [agent]
 * @property {TableSnapshot} [table]
 * @property {MonitorEvent} [event]
 * @property {string} [code]
 * @property {string} [message]
 */

// ---------------------------------------------------------------------------
// Chain, contracts, tokenomics and the wallet-facing endpoints (landing + /stake)
// ---------------------------------------------------------------------------

/**
 * The settlement chain, as reported by `GET /api/v1/health`.
 *
 * `rpcUrl` and `explorerUrl` are `null` until a public endpoint is published:
 * a wallet that does not know this chain can then not be switched to it
 * automatically, and there is no explorer link to render. The UI says so
 * instead of inventing a URL.
 *
 * @typedef {Object} ChainMetadata
 * @property {number} chainId
 * @property {string} name
 * @property {string|null} rpcUrl
 * @property {string|null} explorerUrl
 * @property {{name: string, symbol: string, decimals: number}} nativeCurrency
 */

/**
 * Contract addresses from `GET /api/v1/health`.
 *
 * **Every field may be `null`, and that is the expected state today**: the
 * token is not deployed yet. `null` means "not live yet" and must never be
 * replaced by a placeholder address in the UI.
 *
 * @typedef {Object} ContractAddresses
 * @property {string|null} token
 * @property {string|null} usdg
 * @property {string|null} poker
 * @property {string|null} shuffle
 * @property {string|null} staking
 * @property {string|null} vault
 * @property {string|null} rakeSplitter
 * @property {string|null} buybackBurner
 * @property {string|null} router
 */

/**
 * @typedef {Object} Tokenomics
 * @property {string} tokenSymbol
 * @property {number} tokenDecimals
 * @property {number} buybackBps share of the house edge buying back and burning the token, in basis points
 * @property {number} stakerBps share airdropped to stakers, in basis points
 * @property {ChipsJson} freeGameMinTokens minimum holding for a free-table seat
 * @property {{symbol: string, address?: string|null, decimals?: number}[]} [wagerCurrencies]
 *   currencies a wager table may settle in (`LLMPOKER`, `USDG`, …)
 */

/**
 * @typedef {Object} FreeGate
 * @property {boolean} enabled
 * @property {ChipsJson} minTokens
 * @property {string|null} token
 */

/**
 * `GET /api/v1/gate?wallet=0x…` — the visitor's own free-table eligibility.
 *
 * @typedef {Object} GateResponse
 * @property {boolean} enabled the gate is active (false until the token is live)
 * @property {boolean|null} eligible may this wallet sit at a free table; `null`
 *   when the gate is not active — the honest answer is "not determined", never
 *   "not eligible"
 * @property {ChipsJson} balance the wallet's LLMPOKER balance
 * @property {ChipsJson} required the threshold, base units
 * @property {ChipsJson} requiredTokens the same threshold, whole tokens
 * @property {string} symbol
 * @property {number} decimals
 * @property {string|null} token
 */

/**
 * @typedef {Object} StakingCooldown
 * @property {ChipsJson} amount
 * @property {number} unlockAt when the cooldown expires
 * @property {boolean} [claimable] the server's own verdict; preferred over a
 *   local clock comparison when present
 */

/**
 * `GET /api/v1/staking/summary?wallet=0x…`
 *
 * @typedef {Object} StakingSummary
 * @property {string} wallet
 * @property {string|null} token
 * @property {string} symbol
 * @property {number} decimals
 * @property {ChipsJson} staked
 * @property {ChipsJson} pendingRewards
 * @property {string|null} rewardToken
 * @property {string} rewardSymbol
 * @property {StakingCooldown|null} cooldown
 * @property {ChipsJson} totalStaked the whole pool
 * @property {number} cooldownSeconds
 * @property {ChipsJson} minStake
 */

/** @typedef {'approve'|'stake'|'unstake'|'cancel'|'claim'} StakingAction */

/**
 * `GET /api/v1/staking/tx?wallet=&action=&amount=` — a transaction the server
 * has already encoded.
 *
 * The monitor never builds calldata itself: it hands `to`/`data`/`value` to
 * `eth_sendTransaction` unchanged, so a UI bug can never redirect a stake.
 *
 * @typedef {Object} StakingTxResponse
 * @property {string} to
 * @property {string} data
 * @property {number} chainId
 * @property {ChipsJson} value
 * @property {StakingAction} action
 * @property {string} summary human-readable description of what the transaction does
 */

/**
 * @typedef {Object} HealthResponse
 * @property {boolean} ok
 * @property {string} version
 * @property {number} chainId
 * @property {number} uptimeSeconds
 * @property {number} freeTables
 * @property {number} wagerTables
 * @property {number} agents
 * @property {number} hands
 * @property {'ONCHAIN'|'LOCAL'|null} [rngAnchor] how the in-flight RNG is anchored (`LOCAL` = the free-mode simulator, FR-4.4)
 * @property {'ONCHAIN'|'LOCAL'|null} [settlement] the settlement adapter in use
 * @property {boolean} [wagerEnabled] false when no chain adapter is configured — wager tables are then refused, not downgraded
 * @property {boolean} [walletServices] whether the gate/staking chain services are configured
 * @property {ChainMetadata|null} [chain] absent on an older server — treat as unknown
 * @property {ContractAddresses|null} [contracts] every address may be `null` (not deployed yet)
 * @property {Tokenomics|null} [tokenomics]
 * @property {FreeGate|null} [freeGate]
 */

/**
 * @typedef {Object} AgentsResponse
 * @property {AgentSnapshot[]} agents
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} TablesResponse
 * @property {TableSnapshot[]} tables
 */

/**
 * @typedef {Object} HandsResponse
 * @property {HandSummary[]} hands
 * @property {number} total
 */

/**
 * @typedef {Object} LeaderboardResponse
 * @property {LeaderboardRow[]} rows
 */

/**
 * @typedef {Object} HandVerificationResponse
 * @property {ProofVerification} proof `verifyRngProof()` on the server
 * @property {ProofVerification} deal `verifyHandDeal()` on the server
 * @property {ProofVerification} [settlement] `verifySettlement()` on the server
 */

export {};
