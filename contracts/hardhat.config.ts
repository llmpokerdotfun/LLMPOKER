import type { HardhatUserConfig } from 'hardhat/config';

// NOTE ON MODULE SYNTAX (Hardhat 2 + ESM package)
// ---------------------------------------------------------------------------
// `contracts/package.json` sets `"type": "module"`, and Hardhat 2 loads its
// config through `require()` (`hardhat/internal/core/config/config-loading.js`).
// Node 24 strips the types of a `.ts` file on the fly and its `require(esm)`
// interop returns the module namespace, whose `default` export Hardhat unwraps.
// So this file is written as ordinary ESM TypeScript with `export default`;
// `export =` and `module.exports` are both rejected by Node's strip-only loader.
// ---------------------------------------------------------------------------

const RH_RPC_URL = process.env.RH_RPC_URL?.trim();
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY?.trim();

// `robinhood` is only registered when RH_RPC_URL is present, so a machine with no
// deployment secrets can still run `hardhat test` on the in-process network.
const networks: HardhatUserConfig['networks'] = {
  hardhat: {
    chainId: 31337,
    // The RNG tests walk 256-block reveal windows and the staking tests warp time.
    allowUnlimitedContractSize: false,
    mining: { auto: true },
  },
};

if (RH_RPC_URL) {
  networks.robinhood = {
    url: RH_RPC_URL,
    chainId: 4663,
    accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
  };
}

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // `settleHand` verifies seat-aligned contributions, awards and rake in one frame; the
      // IR pipeline is what keeps a 6-seat settlement inside the EVM stack limit (NFR-3).
      viaIR: true,
    },
  },
  paths: {
    sources: './src',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  networks,
  mocha: {
    timeout: 180_000,
    // Only the top-level `test/*.ts` files are specs; `test/support/**` holds shared fixtures
    // and must not be loaded as a test suite.
    spec: 'test/*.ts',
  },
};

export default config;
