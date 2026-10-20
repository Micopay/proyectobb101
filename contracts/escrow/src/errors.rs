use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    TradeNotFound = 3,
    InvalidSecret = 4,
    TradeNotLocked = 5,
    TimeoutNotReached = 6,
    TimeoutReached = 7,
    Unauthorized = 8,
    InsufficientAmount = 9,
    TradeAlreadyExists = 10,
}
