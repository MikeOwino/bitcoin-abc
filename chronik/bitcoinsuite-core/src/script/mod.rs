// Copyright (c) 2023 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

//! Module for structs and definitions regarding Script.

pub mod opcode;
mod pubkey;
mod uncompressed_pubkey;

pub use self::pubkey::*;
pub use self::uncompressed_pubkey::*;