#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token, Address, Bytes, BytesN, Env,
};

fn setup_env() -> (
    Env,
    Address,  // contract_id
    Address,  // admin
    Address,  // seller
    Address,  // buyer
    Address,  // platform_wallet
    Address,  // token_id
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);
    let platform_wallet = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();

    // Mint tokens to seller: 10,000 MXNe (7 decimals = 100_000_000_000 stroops)
    token::StellarAssetClient::new(&env, &token_id).mint(&seller, &100_000_000_000);

    // Register the escrow contract
    let contract_id = env.register_contract(None, EscrowFactory);

    // Initialize
    let escrow = EscrowFactoryClient::new(&env, &contract_id);
    escrow.initialize(&admin, &token_id, &platform_wallet);

    (env, contract_id, admin, seller, buyer, platform_wallet, token_id)
}

fn make_secret(env: &Env) -> (Bytes, BytesN<32>) {
    let secret = Bytes::from_slice(env, b"test_secret_32_bytes_long_pad__!!");
    let hash: BytesN<32> = env.crypto().sha256(&secret).into();
    (secret, hash)
}

#[test]
fn test_lock_and_release() {
    let (env, contract_id, _, seller, buyer, platform_wallet, token_id) = setup_env();
    let escrow = EscrowFactoryClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token_id);

    let (secret, secret_hash) = make_secret(&env);
    let amount: i128 = 1_500_000_000; // 150 MXNe
    let platform_fee: i128 = 12_000_000; // 1.2 MXNe

    let seller_balance_before = token_client.balance(&seller);

    // Lock
    let trade_id = escrow.lock(
        &seller,
        &buyer,
        &amount,
        &platform_fee,
        &secret_hash,
        &30u32,
    );

    // Verify seller balance decreased by amount + platform_fee
    assert_eq!(
        token_client.balance(&seller),
        seller_balance_before - amount - platform_fee
    );

    // Verify trade state
    let trade = escrow.get_trade(&trade_id);
    assert_eq!(trade.status, TradeStatus::Locked);
    assert_eq!(trade.amount, amount);
    assert_eq!(trade.seller, seller);
    assert_eq!(trade.buyer, buyer);

    // Release with correct secret
    escrow.release(&trade_id, &secret);

    // Verify buyer received the escrowed amount
    assert_eq!(token_client.balance(&buyer), amount);

    // Verify platform received the fee
    assert_eq!(token_client.balance(&platform_wallet), platform_fee);

    // Verify trade is now Released
    let trade_after = escrow.get_trade(&trade_id);
    assert_eq!(trade_after.status, TradeStatus::Released);
}

#[test]
fn test_refund_after_timeout() {
    let (env, contract_id, _, seller, buyer, _, token_id) = setup_env();
    let escrow = EscrowFactoryClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token_id);

    let (_, secret_hash) = make_secret(&env);
    let amount: i128 = 1_500_000_000;
    let platform_fee: i128 = 12_000_000;

    let seller_balance_before = token_client.balance(&seller);

    let trade_id = escrow.lock(
        &seller,
        &buyer,
        &amount,
        &platform_fee,
        &secret_hash,
        &1u32, // 1 minute timeout
    );

    // Advance ledger past timeout (1 minute = ~12 ledgers, advance 20 to be safe)
    let current = env.ledger().get();
    env.ledger().set(LedgerInfo {
        timestamp: current.timestamp + 120,
        sequence_number: current.sequence_number + 20,
        ..current
    });

    // Refund should succeed now
    escrow.refund(&trade_id);

    // Seller should get everything back (amount + platform_fee)
    assert_eq!(token_client.balance(&seller), seller_balance_before);

    let trade = escrow.get_trade(&trade_id);
    assert_eq!(trade.status, TradeStatus::Refunded);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // InvalidSecret
fn test_release_wrong_secret() {
    let (env, contract_id, _, seller, buyer, _, _) = setup_env();
    let escrow = EscrowFactoryClient::new(&env, &contract_id);

    let (_, secret_hash) = make_secret(&env);
    let trade_id =
        escrow.lock(&seller, &buyer, &1_000_000_000i128, &0i128, &secret_hash, &30u32);

    let wrong_secret = Bytes::from_slice(&env, b"wrong_secret_not_matching_hash!!");
    escrow.release(&trade_id, &wrong_secret);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // TimeoutNotReached
fn test_refund_before_timeout() {
    let (env, contract_id, _, seller, buyer, _, _) = setup_env();
    let escrow = EscrowFactoryClient::new(&env, &contract_id);

    let (_, secret_hash) = make_secret(&env);
    let trade_id =
        escrow.lock(&seller, &buyer, &1_000_000_000i128, &0i128, &secret_hash, &30u32);

    // Try refund before timeout — should panic
    escrow.refund(&trade_id);
}

#[test]
fn test_double_initialize_fails() {
    let (env, contract_id, admin, _, _, platform_wallet, token_id) = setup_env();
    let escrow = EscrowFactoryClient::new(&env, &contract_id);

    // Second initialize should return an error
    let result = escrow.try_initialize(&admin, &token_id, &platform_wallet);
    assert!(result.is_err());
}

#[test]
fn test_lock_rejects_reused_secret_hash() {
    let (env, contract_id, _, seller, buyer, _, token_id) = setup_env();
    let escrow = EscrowFactoryClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token_id);

    let attacker = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token_id).mint(&attacker, &10);

    let (secret, secret_hash) = make_secret(&env);
    let amount: i128 = 1_000_000_000;
    let trade_id = escrow.lock(&seller, &buyer, &amount, &0i128, &secret_hash, &30u32);

    // El secret_hash es publico: repetirlo con 1 stroop no debe pisar la operacion.
    let result = escrow.try_lock(&attacker, &attacker, &1i128, &0i128, &secret_hash, &1u32);
    assert_eq!(result, Err(Ok(EscrowError::TradeAlreadyExists)));
    assert_eq!(token_client.balance(&attacker), 10);

    let trade = escrow.get_trade(&trade_id);
    assert_eq!(trade.seller, seller);
    assert_eq!(trade.amount, amount);

    // La operacion original se sigue liberando con normalidad.
    escrow.release(&trade_id, &secret);
    assert_eq!(token_client.balance(&buyer), amount);
    assert_eq!(token_client.balance(&contract_id), 0);
}
