import * as ecc from '@bitcoinerlab/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';

// Taproot (tb1p…) output scripts are validated through the ECC library; without it bitcoinjs-lib rejects them.
bitcoin.initEccLib(ecc);

export const ECPair = ECPairFactory(ecc);
