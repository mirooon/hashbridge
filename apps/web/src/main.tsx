import '@mysten/dapp-kit/dist/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectButton, SuiClientProvider, WalletProvider, createNetworkConfig, useCurrentAccount } from '@mysten/dapp-kit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { WalletClaim } from './components/WalletClaim';
import { HTLC_PACKAGE_ID, SUI_RPC_URL } from './config';
import './index.css';

const { networkConfig } = createNetworkConfig({ testnet: { url: SUI_RPC_URL } });
const queryClient = new QueryClient();

function WalletApp() {
  const account = useCurrentAccount();
  return (
    <App
      walletAddress={account?.address ?? null}
      walletSlot={<ConnectButton connectText="Connect" />}
      fallbackSlot={(recovery, view) => <WalletClaim recovery={recovery} htlcObjectId={view?.htlcObjectId ?? null} packageId={HTLC_PACKAGE_ID} />}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider autoConnect>
          <WalletApp />
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  </StrictMode>,
);
