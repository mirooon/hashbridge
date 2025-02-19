/**
 * Manual, read-only live check of the Sui adapter against testnet (not part of `pnpm test`):
 *   pnpm --filter @hashbridge/bot exec tsx scripts/sui-smoke.ts
 * Uses a throwaway key, so it never signs or sends anything.
 */
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createSuiChain, graphqlUrlFor } from '../src/sui-chain';

const rpcUrl = 'https://fullnode.testnet.sui.io:443';
const chain = createSuiChain({ rpcUrl, privateKey: Ed25519Keypair.generate().getSecretKey(), packageId: '0x' + '0'.repeat(64) });

console.log('rpcUrl:', rpcUrl);
console.log('address():', chain.address());
console.log('balanceMist() (expect 0):', (await chain.balanceMist()).toString());
// All-ones base58 = 32 zero bytes: a well-formed digest no transaction has.
console.log("lookup('11111111111111111111111111111111') (expect null):", await chain.lookup('11111111111111111111111111111111'));

const graphqlUrl = graphqlUrlFor(rpcUrl);
const { data, errors } = await new SuiGraphQLClient({ url: graphqlUrl }).query({ query: '{ chainIdentifier }', variables: {} });
console.log(`GraphQL ${graphqlUrl} { chainIdentifier }:`, JSON.stringify(errors ?? data));
