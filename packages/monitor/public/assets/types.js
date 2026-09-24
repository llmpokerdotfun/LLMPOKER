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
 * @property {number[]|null} holeCards
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
 * @property {string|null} rngCommitment
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
 * @typedef {Object} RngProof
 * @property {string} handId
 * @property {string} tableId
 * @property {number} handNumber
 * @property {string} commitment
 * @property {string|null} deckSeed
 * @property {string} nonce
 * @property {number|null} commitBlock
 * @property {string|null} commitTxHash
 * @property {number|null} anchorBlock
 * @property {string|null} anchorBlockHash
 * @property {number|null} revealBlock
 * @property {string|null} revealTxHash
 * @property {string|null} entropy
 * @property {number[]} deck
 * @property {boolean} verified
 * @property {number|null} verifiedAt
 * @property {number} chainId
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
 * @property {number[]} deck
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
 * @property {number|null} revealBlock
 * @property {boolean} proofVerified
 * @property {boolean} [fromLive] Locally derived from a WS delta, not from `/api/v1/hands`.
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

/**
 * @typedef {Object} TableEventEnvelope
 * @property {number} seq
 * @property {number} at
 * @property {string} tableId
 * @property {any} payload
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
 * @property {ProofVerification} proof
 * @property {ProofVerification} deal
 */

export {};
