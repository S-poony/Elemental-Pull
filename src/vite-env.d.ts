/// <reference types="vite/client" />
// Pulls in the types for import.meta.env — main.tsx reads BASE_URL and PROD
// to register the service worker at the right path, and without this the
// project typecheck (npx tsc -p tsconfig.app.json --noEmit) rejects both.
