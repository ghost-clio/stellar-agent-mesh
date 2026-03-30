export interface AgentService {
  id: string;
  capability: string;
  price: number;
  endpoint: string;
}

export interface Agent {
  name: string;
  pubkey: string;
  services: AgentService[];
}

export const agents: Agent[] = [
  {
    name: "Atlas",
    pubkey: "GATLASX7RZVNMQCFO3YZUQP4GDVK3YPQKFMJR5BTONH2MSCVDJN7OYA",
    services: [
      {
        id: "atlas-web-search",
        capability: "web-search",
        price: 0.50,
        endpoint: "http://localhost:4001/web-search",
      },
      {
        id: "atlas-news-aggregation",
        capability: "news-aggregation",
        price: 1.25,
        endpoint: "http://localhost:4001/news-aggregation",
      },
    ],
  },
  {
    name: "Sage",
    pubkey: "GSAGEQR4WKFLV2NCHTZHY5BEJAC6PMHXGIRDSW3QLVT7DG3YPKE2WV5J",
    services: [
      {
        id: "sage-code-review",
        capability: "code-review",
        price: 1.75,
        endpoint: "http://localhost:4002/code-review",
      },
      {
        id: "sage-bug-analysis",
        capability: "bug-analysis",
        price: 2.00,
        endpoint: "http://localhost:4002/bug-analysis",
      },
    ],
  },
  {
    name: "Pixel",
    pubkey: "GPIXELK3NMXV7YQ2RSTJ4DHFW6BZHCAQE5LPM7KVOIT3XRDGA8WN4U5H",
    services: [
      {
        id: "pixel-image-gen",
        capability: "image-gen",
        price: 1.50,
        endpoint: "http://localhost:4003/image-gen",
      },
      {
        id: "pixel-style-transfer",
        capability: "style-transfer",
        price: 0.75,
        endpoint: "http://localhost:4003/style-transfer",
      },
    ],
  },
  {
    name: "Quant",
    pubkey: "GQUANTW8RLHVJ5DX2FNM3YKPC7ATGZE6SQVBO4XRKIT9MJHF3CDLW2N7",
    services: [
      {
        id: "quant-market-data",
        capability: "market-data",
        price: 0.10,
        endpoint: "http://localhost:4004/market-data",
      },
      {
        id: "quant-risk-scoring",
        capability: "risk-scoring",
        price: 1.00,
        endpoint: "http://localhost:4004/risk-scoring",
      },
    ],
  },
];
