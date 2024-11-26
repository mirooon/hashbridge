import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory } from 'ecpair';

export const ECPair = ECPairFactory(ecc);
