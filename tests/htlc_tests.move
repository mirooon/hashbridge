#[test_only]
module hashbridge::htlc_tests;

use hashbridge::htlc::{Self, Htlc};
use std::hash::sha2_256;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const ALICE: address = @0xA11CE; // zamyka SUI
const BOB: address = @0xB0B; // zna sekret, odbiera SUI
const DEADLINE: u64 = 1_000;

/// Alice zamyka 100 SUI dla Boba pod sha256("sekret").
fun setup(): (Scenario, Clock) {
    let mut s = ts::begin(ALICE);
    let clock = clock::create_for_testing(s.ctx());
    let coin = coin::mint_for_testing<SUI>(100, s.ctx());
    htlc::lock(coin, BOB, sha2_256(b"sekret"), DEADLINE, &clock, s.ctx());
    (s, clock)
}

#[test]
fun bob_claims_with_preimage() {
    let (mut s, clock) = setup();

    s.next_tx(BOB);
    let h = s.take_shared<Htlc<SUI>>();
    assert!(htlc::amount(&h) == 100);
    htlc::claim(h, b"sekret", &clock, s.ctx());

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
    htlc::claim(h, b"zgaduje", &clock, s.ctx());
    abort 0
}

#[test]
#[expected_failure(abort_code = htlc::EExpired)]
fun claim_after_deadline_fails() {
    let (mut s, mut clock) = setup();
    clock.set_for_testing(DEADLINE);
    s.next_tx(BOB);
    let h = s.take_shared<Htlc<SUI>>();
    htlc::claim(h, b"sekret", &clock, s.ctx());
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
    htlc::lock(coin, BOB, b"za_krotki", DEADLINE, &clock, s.ctx());
    abort 0
}
