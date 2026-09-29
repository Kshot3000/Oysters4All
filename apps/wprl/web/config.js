/* wPRL bridge site — PUBLIC configuration. No secrets here, ever.
 *
 * Fill in the deployment values once the testnet deploy happens.
 * Everything else (fees, conversions, validation) is shared with the
 * contracts/backend so the UI can never disagree with them. */
window.WPRL_CONFIG = {
  networkName: "Base Sepolia",
  chainId: 11155111,
  testnet: true,

  /* Operator's Pearl vault address (prl1…). Deposits go here. */
  vaultAddress: "",

  /* Deployed contract addresses on Base Sepolia — empty until testnet deploy. */
  bridgeAddress: "",
  tokenAddress: "",
  deployBlock: "",

  /* Proof-of-reserves API base URL, e.g. "https://wprl-operator.example.com".
   * The site calls <url>/reserves. Empty = dashboard shows an honest
   * "not published yet" state instead of fake numbers. */
  reservesApiUrl: "",

  /* Bridge economics — MUST match the deployed contracts (WPRLBridge + backend). */
  feeBps: 25,                    // 0.25% each way
  minDepositGrains: "100000",    // 0.001 PRL dust guard
  minConfirmations: 6,
  grainsPerPrl: "100000000",     // 1 PRL = 1e8 grains (upstream node/btcutil/const.go)
  weiPerGrain: "10000000000",    // 1 grain = 1e10 wei (exact)

  /* Fee recipients — public by design. */
  prlFeeAddress: "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d",
  evmFeeAddress: "0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1",
};
