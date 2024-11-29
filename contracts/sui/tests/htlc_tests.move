#[test_only]
module hashbridge::htlc_tests;

use hashbridge::htlc::{Self, Htlc};
use std::hash::sha2_256;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const ALICE: address = @0xA11CE; // locks SUI
const BOB: address = @0xB0B; // knows the secret, claims SUI
const DEADLINE: u64 = 1_000;

fun bytes(b: u8, n: u64): vector<u8> {
    let mut v = vector[];
    let mut i = 0;
    while (i < n) {
        v.push_back(b);
        i = i + 1;
    };
    v
}

fun secret(): vector<u8> { bytes(1, 32) }

/// Alice locks 100 SUI for Bob under sha256(secret()).
fun setup(): (Scenario, Clock) {
    let mut s = ts::begin(ALICE);
    let clock = clock::create_for_testing(s.ctx());
    let coin = coin::mint_for_testing<SUI>(100, s.ctx());
    htlc::lock(coin, BOB, sha2_256(secret()), DEADLINE, &clock, s.ctx());
    (s, clock)
}

#[test]
fun bob_claims_with_preimage() {
    let (mut s, clock) = setup();

    s.next_tx(BOB);
    let h = s.take_shared<Htlc<SUI>>();
    assert!(htlc::amount(&h) == 100);
    htlc::claim(h, secret(), &clock, s.ctx());

    s.next_tx(BOB);
    let c = s.take_from_sender<Coin<SUI>>();
    assert!(c.value() == 100);
    s.return_to_sender(c);

    clock.destroy_for_testing();
    s.end();
}

#[test]
fun alice_refunds_after_deadline() {
    let (mut s, mut clock) = setup();
    clock.set_for_testing(DEADLINE);

    s.next_tx(ALICE);
    let h = s.take_shared<Htlc<SUI>>();
    htlc::refund(h, &clock, s.ctx());

    s.next_tx(ALICE);
    let c = s.take_from_sender<Coin<SUI>>();
    assert!(c.value() == 100);
    s.return_to_sender(c);

    clock.destroy_for_testing();
    s.end();
}

#[test]
#[expected_failure(abort_code = htlc::EWrongPreimage)]
fun wrong_preimage_fails() {
    let (mut s, clock) = setup();
    s.next_tx(BOB);
    let h = s.take_shared<Htlc<SUI>>();
    htlc::claim(h, bytes(2, 32), &clock, s.ctx());
    abort 0
}

#[test]
#[expected_failure(abort_code = htlc::EBadPreimageLength)]
fun short_preimage_fails() {
    let (mut s, clock) = setup();
    s.next_tx(BOB);
    let h = s.take_shared<Htlc<SUI>>();
    htlc::claim(h, bytes(1, 31), &clock, s.ctx());
    abort 0
}

#[test]
#[expected_failure(abort_code = htlc::EBadPreimageLength)]
fun long_preimage_fails() {
    let (mut s, clock) = setup();
    s.next_tx(BOB);
    let h = s.take_shared<Htlc<SUI>>();
    htlc::claim(h, bytes(1, 600), &clock, s.ctx());
    abort 0
}

#[test]
#[expected_failure(abort_code = htlc::EExpired)]
fun claim_after_deadline_fails() {
    let (mut s, mut clock) = setup();
    clock.set_for_testing(DEADLINE);
    s.next_tx(BOB);
    let h = s.take_shared<Htlc<SUI>>();
    htlc::claim(h, secret(), &clock, s.ctx());
    abort 0
}

#[test]
#[expected_failure(abort_code = htlc::ENotExpired)]
fun refund_before_deadline_fails() {
    let (mut s, clock) = setup();
    s.next_tx(ALICE);
    let h = s.take_shared<Htlc<SUI>>();
    htlc::refund(h, &clock, s.ctx());
    abort 0
}

#[test]
#[expected_failure(abort_code = htlc::EBadHashLength)]
fun bad_hash_length_fails() {
    let mut s = ts::begin(ALICE);
    let clock = clock::create_for_testing(s.ctx());
    let coin = coin::mint_for_testing<SUI>(100, s.ctx());
    htlc::lock(coin, BOB, bytes(9, 31), DEADLINE, &clock, s.ctx());
    abort 0
}
