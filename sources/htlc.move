/// Strona Sui atomic swapu BTC <-> Sui.
///
/// Odpowiednik skryptu HTLC na Bitcoinie:
///   OP_IF   OP_SHA256 <hash> OP_EQUALVERIFY <recipient> OP_CHECKSIG
///   OP_ELSE <refund_after> OP_CHECKLOCKTIMEVERIFY OP_DROP <sender> OP_CHECKSIG
///   OP_ENDIF
///
/// Hash to SHA-256, czyli ten sam sekret odblokowuje obie strony.
/// `claim` publikuje preimage w evencie, więc druga strona może go
/// odczytać i odebrać BTC.
module hashbridge::htlc;

use std::hash::sha2_256;
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

const EZeroAmount: u64 = 0;
const EBadHashLength: u64 = 1;
const ETimelockInPast: u64 = 2;
const EWrongPreimage: u64 = 3;
const EExpired: u64 = 4;
const ENotExpired: u64 = 5;

/// Zamknięte środki. Obiekt jest współdzielony (shared), bo muszą go móc
/// dotknąć dwie strony: odbiorca przy `claim`, nadawca przy `refund`.
public struct Htlc<phantom T> has key {
    id: UID,
    balance: Balance<T>,
    sender: address,
    recipient: address,
    hash: vector<u8>,
    refund_after_ms: u64,
}

public struct Locked has copy, drop {
    htlc_id: ID,
    sender: address,
    recipient: address,
    amount: u64,
    hash: vector<u8>,
    refund_after_ms: u64,
}

public struct Claimed has copy, drop {
    htlc_id: ID,
    preimage: vector<u8>,
}

public struct Refunded has copy, drop {
    htlc_id: ID,
}

/// Zamyka `coin` pod hashem. Odbiorca może go odebrać do `refund_after_ms`,
/// potem nadawca może go odzyskać.
public fun lock<T>(
    coin: Coin<T>,
    recipient: address,
    hash: vector<u8>,
    refund_after_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    let amount = coin.value();
    assert!(amount > 0, EZeroAmount);
    assert!(hash.length() == 32, EBadHashLength);
    assert!(refund_after_ms > clock.timestamp_ms(), ETimelockInPast);

    let htlc = Htlc {
        id: object::new(ctx),
        balance: coin.into_balance(),
        sender: ctx.sender(),
        recipient,
        hash,
        refund_after_ms,
    };
    let htlc_id = object::id(&htlc);
    event::emit(Locked { htlc_id, sender: ctx.sender(), recipient, amount, hash, refund_after_ms });
    transfer::share_object(htlc);
    htlc_id
}

/// Każdy może podać preimage, ale środki zawsze idą do `recipient`.
public fun claim<T>(htlc: Htlc<T>, preimage: vector<u8>, clock: &Clock, ctx: &mut TxContext) {
    assert!(clock.timestamp_ms() < htlc.refund_after_ms, EExpired);
    assert!(sha2_256(preimage) == htlc.hash, EWrongPreimage);

    let Htlc { id, balance, sender: _, recipient, hash: _, refund_after_ms: _ } = htlc;
    event::emit(Claimed { htlc_id: id.to_inner(), preimage });
    id.delete();
    transfer::public_transfer(coin::from_balance(balance, ctx), recipient);
}

/// Po upływie czasu każdy może wywołać zwrot, ale środki zawsze idą do `sender`.
public fun refund<T>(htlc: Htlc<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(clock.timestamp_ms() >= htlc.refund_after_ms, ENotExpired);

    let Htlc { id, balance, sender, recipient: _, hash: _, refund_after_ms: _ } = htlc;
    event::emit(Refunded { htlc_id: id.to_inner() });
    id.delete();
    transfer::public_transfer(coin::from_balance(balance, ctx), sender);
}

public fun amount<T>(h: &Htlc<T>): u64 { h.balance.value() }

public fun sender<T>(h: &Htlc<T>): address { h.sender }

public fun recipient<T>(h: &Htlc<T>): address { h.recipient }

public fun hash<T>(h: &Htlc<T>): vector<u8> { h.hash }

public fun refund_after_ms<T>(h: &Htlc<T>): u64 { h.refund_after_ms }
