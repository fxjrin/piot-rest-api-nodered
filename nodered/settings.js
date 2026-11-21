const path = require("node:path");

module.exports = {
  uiPort: process.env.PORT || 1880,
  flowFile: "flows.json",
  credentialSecret: false,

  // Dashboard dibuka lewat http://localhost:1880/dashboard/ (satu origin dengan API dan WebSocket)
  httpStatic: [{ path: path.join(__dirname, "..", "public"), root: "/dashboard/" }],

  // Agar dashboard tetap bisa dibuka langsung sebagai file (origin berbeda)
  httpNodeCors: {
    origin: "*",
    methods: "GET,PUT,POST,OPTIONS",
    allowedHeaders: "Content-Type,X-API-Key"
  },

  logging: { console: { level: "info", metrics: false, audit: false } },
  telemetry: { enabled: false },
  editorTheme: { tours: false }
};
