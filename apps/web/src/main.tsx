import '@mysten/dapp-kit/dist/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectButton, SuiClientProvider, WalletProvider, useCurrentAccount } from '@mysten/dapp-kit';
import { SuiClient } from '@mysten/sui/client';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { WalletClaim } from './components/WalletClaim';
import { HTLC_PACKAGE_ID, SUI_RPC_URL } from './config';
import './index.css';

const suiGrpc = new SuiGrpcClient({ network: 'testnet', baseUrl: SUI_RPC_URL });

/**
 * dapp-kit 0.20 only accepts a JSON-RPC SuiClient, and public fullnodes no longer serve JSON-RPC. The wallet claim
 * needs dapp-kit only for signing (tx.toJSON makes no request for our claim and the wallet resolves gas and objects
 * itself) and executes over gRPC, so this client refuses every JSON-RPC call locally instead of sending requests
 * that would fail anyway. The one caller left, the SuiNS name lookup in ConnectButton, then shows the address.
 */
const noJsonRpcClient = new SuiClient({
  network: 'testnet',
  transport: {
    request: async ({ method }) => {
      throw new Error(`Sui JSON-RPC is not used (${method}): this app reads Sui through GraphQL and gRPC`);
    },
    subscribe: async ({ method }) => {
      throw new Error(`Sui JSON-RPC is not used (${method}): this app reads Sui through GraphQL and gRPC`);
    },
  },
});
const networks = { testnet: noJsonRpcClient };
const queryClient = new QueryClient();

function WalletApp() {
  const account = useCurrentAccount();
  return (
    <App
      walletAddress={account?.address ?? null}
      walletSlot={<ConnectButton connectText="Connect" />}
      fallbackSlot={(recovery, view) => (
        <WalletClaim recovery={recovery} htlcObjectId={view?.htlcObjectId ?? null} packageId={HTLC_PACKAGE_ID} suiClient={suiGrpc} />
      )}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networks} defaultNetwork="testnet">
        <WalletProvider autoConnect>
          <WalletApp />
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  </StrictMode>,
);
