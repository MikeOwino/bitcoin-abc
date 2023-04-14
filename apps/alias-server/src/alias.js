// Copyright (c) 2023 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

'use strict';
const cashaddr = require('ecashaddrjs');
const config = require('../config');
const log = require('./log');
const {
    getAliasFromHex,
    isValidAliasString,
    getOutputScriptFromAddress,
} = require('./utils');

module.exports = {
    getAliasTxs: function (aliasTxHistory, aliasConstants) {
        const aliasTxCount = aliasTxHistory.length;

        // Get expected output script match for parseAliasTx
        // Do it here and not in parseAliasTx so that you don't do it for every single tx
        // Will all be the same for a given set of tx history
        const registrationOutputScript = getOutputScriptFromAddress(
            aliasConstants.registrationAddress,
        );

        // initialize array for all valid aliases
        const aliasTxs = [];
        // iterate over history to get all alias:address pairs
        for (let i = 0; i < aliasTxCount; i += 1) {
            const thisAliasTx = aliasTxHistory[i];
            const parsedAliasTx = module.exports.parseAliasTx(
                thisAliasTx,
                aliasConstants,
                registrationOutputScript,
            );
            if (parsedAliasTx) {
                aliasTxs.push(parsedAliasTx);
            }
        }
        return aliasTxs;
    },
    parseAliasTx: function (aliasTx, aliasConstants, registrationOutputScript) {
        // Input: a single tx from chronik tx history
        // output: false if invalid tx
        // output: {address: 'address', alias: 'alias', txid} if valid
        // validate for alias tx

        const inputZeroOutputScript = aliasTx.inputs[0].outputScript;

        const registeringAddress = cashaddr.encodeOutputScript(
            inputZeroOutputScript,
        );

        // Initialize vars used later for validation
        let aliasFeePaidSats = BigInt(0);
        let alias;
        let aliasLength;

        // Iterate over outputs
        const outputs = aliasTx.outputs;
        for (let i = 0; i < outputs.length; i += 1) {
            const { value, outputScript } = outputs[i];
            // If value is 0, parse for OP_RETURN
            if (value === '0') {
                // Check for valid alias prefix
                const validAliasPrefix =
                    outputScript.slice(0, 12) ===
                    `6a04${aliasConstants.opCodePrefix}`;

                if (!validAliasPrefix) {
                    return false;
                }

                // Check for valid alias length
                const aliasLengthHex = outputScript.slice(12, 14);
                aliasLength = parseInt(aliasLengthHex, 16);

                // Parse for the alias
                const aliasHex = outputScript.slice(14, outputScript.length);
                alias = getAliasFromHex(aliasHex);

                // Check for valid character set
                // only lower case roman alphabet a-z
                // numbers 0 through 9
                if (!isValidAliasString(alias)) {
                    return false;
                }

                const validAliasLength =
                    aliasLength <= aliasConstants.maxLength &&
                    aliasHex.length === 2 * aliasLength;

                if (!validAliasLength) {
                    return false;
                }
            } else {
                // Check if outputScript matches alias registration address
                if (outputScript === registrationOutputScript)
                    // If so, then the value here is part of the alias registration fee, aliasFeePaidSats
                    aliasFeePaidSats += BigInt(value);
            }
        }
        // If `alias` is undefined after the above loop, then this is not a valid alias registration tx
        if (typeof alias === 'undefined') {
            return false;
        }
        // Confirm that the correct fee is paid to the correct address
        if (
            parseInt(aliasFeePaidSats) <
            aliasConstants.registrationFeesSats[aliasLength]
        ) {
            log(
                `Invalid fee. This transaction paid ${aliasFeePaidSats} sats to register ${alias}. The correct fee for an alias of ${aliasLength} characters is ${aliasConstants.registrationFeesSats[aliasLength]}`,
            );
            return false;
        }
        return {
            address: registeringAddress,
            alias,
            txid: aliasTx.txid,
            // arbitrary to set unconfirmed txs at blockheight of 100,000,000
            // note that this constant must be adjusted in the fall of 3910 A.D., assuming 10 min blocks
            // setting it high instead of zero because it's important we sort aliases by blockheight
            // for sortAliasTxsByTxidAndBlockheight function
            blockheight:
                aliasTx && aliasTx.block
                    ? aliasTx.block.height
                    : config.unconfirmedBlockheight,
        };
    },
    sortAliasTxsByTxidAndBlockheight: function (unsortedAliasTxs) {
        // First, sort the aliases array by alphabetical txid
        // (alphabetical first to last, 0 comes before a comes before b comes before c, etc)
        const aliasesTxsSortedByTxid = unsortedAliasTxs.sort((a, b) => {
            return a.txid.localeCompare(b.txid);
        });

        // Next, sort the aliases array by blockheight. This will preserve the alphabetical txid sort
        // 735,625 comes before 735,626 comes before 100,000,000 etc
        const aliasTxsSortedByTxidAndBlockheight = aliasesTxsSortedByTxid.sort(
            (a, b) => {
                return a.blockheight - b.blockheight;
            },
        );

        return aliasTxsSortedByTxidAndBlockheight;
    },
    getValidAliasRegistrations: function (unsortedAliasTxs) {
        // Sort aliases such that the earliest aliases are the valid ones
        const aliasesSortedByTxidAndBlockheight =
            module.exports.sortAliasTxsByTxidAndBlockheight(unsortedAliasTxs);

        // Initialize arrays to store alias registration info
        let registeredAliases = [];
        let validAliasRegistrations = [];

        // Iterate over sorted aliases starting from oldest registrations to newest
        // (and alphabetically first txids to last)
        for (let i = 0; i < aliasesSortedByTxidAndBlockheight.length; i += 1) {
            const thisAliasTx = aliasesSortedByTxidAndBlockheight[i];
            const { alias, blockheight } = thisAliasTx;

            // If you haven't seen this alias yet, it's a valid registered alias
            if (!registeredAliases.includes(alias)) {
                // If the tx is confirmed, add this alias to the registeredAlias array
                registeredAliases.push(alias);
                // If the tx is confirmed,
                if (blockheight < 100000000) {
                    // Add thisAliasObject to the validAliasObjects array
                    validAliasRegistrations.push(thisAliasTx);
                }
            } else {
                // If you've already seen it at an earlier blockheight or earlier alphabetical txid,
                // then this is not a valid registration.
                // Do not include it in valid registrations

                // Note, we could just remove this else block. But it's useful for code readability.
                continue;
            }
        }
        return validAliasRegistrations;
    },
};
