// Networks Stagepay is deployed on. Pick one with ?net=<key>; Arc mainnet is the default.
export const DEFAULT_NET = 'arc';

export const NETWORKS = {
  arc: {
    label: 'Arc mainnet',
    chainId: 5042,
    name: 'Arc',
    native: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    contract: '0x0A87039a127b600cF9B85d4C33d97c08054e15E6',
    deployBlock: 22535593,
    minFeeGwei: 25, // Arc drops transactions below its 20 gwei base-fee floor
    feeNote: 'Network fees are paid in USDC (about a cent each).',
    tokens: {
      USDC: { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
      EURC: { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 },
    },
  },
  'arbitrum-sepolia': {
    label: 'Arbitrum Sepolia',
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    native: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorer: 'https://sepolia.arbiscan.io',
    contract: '0x0A87039a127b600cF9B85d4C33d97c08054e15E6',
    deployBlock: 312175664,
    minFeeGwei: 0,
    feeNote: 'Network fees are paid in testnet ETH.',
    tokens: {
      USDG: { address: '0xFFC95faa3d63Cde504a05B567C600B78C0b41892', decimals: 6 },
      USDC: { address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', decimals: 6 },
    },
  },
};
