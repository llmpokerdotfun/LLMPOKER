import type { HardhatUserConfig } from 'hardhat/config';
// Hardhat 2 loads its config through `require()`, and `ts-node` transpiles this file with
// `contracts/tsconfig.json` (`module: commonjs`). That is why `contracts/package.json` does
// NOT declare `"type": "module"`: with it, ts-node treats every `.ts` file in this package as
// ESM and Hardhat aborts config loading with
// "Error HH19: Your project is an ESM project ... but your Hardhat config file uses the .js
// extension". Nothing else in this workspace depends on that field.
//
// The plugin set is imported explicitly instead of pulling in
// `@nomicfoundation/hardhat-toolbox`: the toolbox's transitive `solidity-coverage` plugin
// throws at load time in this environment ("TypeError: subtask is not a function") from
// inside `hardhat/config`'s live re-exports, which aborts config loading and leaves
// `hre.ethers` undefined. The toolbox only bundles these plugins, so listing the ones this
// suite uses is equivalent.
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-chai-matchers';

const RH_RPC_URL = process.env.RH_RPC_URL?.trim();
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY?.trim();

// `robinhood` is only registered when RH_RPC_URL is present, so a machine with no
// deployment secrets can still run `hardhat test` on the in-process network.
const LOCALHOST_RPC_URL = process.env.LOCALHOST_RPC_URL?.trim() || 'http://127.0.0.1:8545';

const networks: HardhatUserConfig['networks'] = {
  hardhat: {
    chainId: 31337,
    // The RNG tests walk 256-block reveal windows and the staking tests warp time.
    allowUnlimitedContractSize: false,
    mining: { auto: true },
  },
  // A standalone `npx hardhat node` (its first ten funded accounts are the well-known
  // development keys, so no secret material is needed to deploy to it). This is what
  // `npm run e2e:onchain` targets: a real RPC with real transactions, still not a public chain.
  localhost: {
    url: LOCALHOST_RPC_URL,
    chainId: 31337,
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
    // and must not be loaded as a test suite. `spec` is a real Mocha option that Hardhat's
    // `MochaOptions` type does not surface, so the object is widened for this one field.
    spec: 'test/*.ts',
  } as HardhatUserConfig['mocha'] & { spec: string },
};

export default config;
