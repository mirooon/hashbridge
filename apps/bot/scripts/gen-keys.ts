import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ECPair } from '@hashbridge/core/ecc';
import { p2wpkhAddress } from '@hashbridge/core/keys';
import { BTC_NETWORK } from '@hashbridge/core/network';

const btc = ECPair.makeRandom({ network: BTC_NETWORK });
const sui = Ed25519Keypair.generate();

console.log(`BTC_WIF=${btc.toWIF()}`);
console.log(`# fund this signet address: ${p2wpkhAddress(new Uint8Array(btc.publicKey))}`);
console.log(`SUI_PRIVATE_KEY=${sui.getSecretKey()}`);
console.log(`# fund this Sui testnet address: ${sui.toSuiAddress()}`);
