// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

import { ChronikClient, PluginEndpoint, Token, Utxo } from 'chronik-client';
import {
    Bytes,
    DEFAULT_DUST_LIMIT,
    DEFAULT_FEE_PER_KB,
    Ecc,
    EccDummy,
    fromHex,
    OutPoint,
    readTxOutput,
    Script,
    slpSend,
    strToBytes,
    toHex,
    Tx,
    TxBuilder,
    TxBuilderInput,
    TxBuilderOutput,
    TxInput,
    TxOutput,
} from 'ecash-lib';

import {
    AgoraOneshot,
    AgoraOneshotCancelSignatory,
    AgoraOneshotSignatory,
} from './oneshot.js';

const TOKEN_ID_PREFIX = toHex(strToBytes('T'));
const PUBKEY_PREFIX = toHex(strToBytes('P'));
const FUNGIBLE_TOKEN_ID_PREFIX = toHex(strToBytes('F'));
const GROUP_TOKEN_ID_PREFIX = toHex(strToBytes('G'));
const PLUGIN_NAME = 'agora';

const ONESHOT_HEX = toHex(strToBytes(AgoraOneshot.COVENANT_VARIANT));

const PLUGIN_GROUPS_MAX_PAGE_SIZE = 50;

/** Offer variant, determines the Script used to enforce the offer */
export type AgoraOfferVariant = {
    type: 'ONESHOT';
    params: AgoraOneshot;
};

/**
 * Individual token offer on the Agora, i.e. one UTXO offering tokens.
 *
 * It can be used to accept or cancel the offer.
 */
export class AgoraOffer {
    public variant: AgoraOfferVariant;
    public outpoint: OutPoint;
    public txBuilderInput: TxInput;
    public token: Token;

    public constructor(params: {
        variant: AgoraOfferVariant;
        outpoint: OutPoint;
        txBuilderInput: TxInput;
        token: Token;
    }) {
        this.variant = params.variant;
        this.outpoint = params.outpoint;
        this.txBuilderInput = params.txBuilderInput;
        this.token = params.token;
    }

    /**
     * Build a tx accepting this offer.
     *
     * Agora offers are UTXOs on the blockchain that can be accepted by anyone
     * sending sufficient satoshis to a required output.
     *
     * `fuelInputs` has to provide enough sats for this offer to cover ask + tx fee.
     * */
    public acceptTx(params: {
        /** ECC object to sign signatures. */
        ecc: Ecc;
        /**
         * Arbitrary secret key to sign the accept tx with. Recommended to set
         * this to a random key. Must be paired with covenantSk.
         **/
        covenantSk: Uint8Array;
        /**
         * Arbitrary public key to sign the accept tx with, must be paired with
         * covenantSk.
         **/
        covenantPk: Uint8Array;
        /**
         * Inputs fueling this tx to cover tx fee and asked sats for the
         * enforced outputs. Must have signatory and input.signData set
         * correctly. If it is set incorrectly, may fail silently and build an
         * invalid tx, failing at broadcast.
         *
         * The free sats of these inputs must be at least askedSats + acceptFeeSats.
         **/
        fuelInputs: TxBuilderInput[];
        /** Script to send the tokens and the leftover sats (if any) to. */
        recipientScript: Script;
        /** Dust amount to use for the token output. */
        dustAmount?: number;
        /** Fee per kB to use when building the tx. */
        feePerKb?: number;
    }): Tx {
        const dustAmount = params.dustAmount ?? DEFAULT_DUST_LIMIT;
        const feePerKb = params.feePerKb ?? DEFAULT_FEE_PER_KB;
        const txBuild = this._acceptTxBuilder({
            covenantSk: params.covenantSk,
            covenantPk: params.covenantPk,
            fuelInputs: params.fuelInputs,
            extraOutputs: [
                {
                    value: dustAmount,
                    script: params.recipientScript,
                },
                params.recipientScript,
            ],
        });
        return txBuild.sign(params.ecc, feePerKb, dustAmount);
    }

    /**
     * How many extra satoshis are required to fuel this offer so it can be
     * broadcast on the network, excluding the asked sats.
     * This should be displayed to the user as network fee.
     * The total required input amount is askedSats + acceptFeeSats.
     **/
    public acceptFeeSats(params: {
        /** Script to send the tokens and the leftover sats (if any) to. */
        recipientScript: Script;
        /** Extra inputs */
        extraInputs?: TxBuilderInput[];
        /** Fee per kB to use when building the tx. */
        feePerKb?: number;
    }): bigint {
        const feePerKb = params.feePerKb ?? DEFAULT_FEE_PER_KB;
        const txBuild = this._acceptTxBuilder({
            covenantSk: new Uint8Array(32),
            covenantPk: new Uint8Array(33),
            fuelInputs: params.extraInputs ?? [],
            extraOutputs: [
                {
                    value: 0,
                    script: params.recipientScript,
                },
            ],
        });
        const measureTx = txBuild.sign(new EccDummy());
        return BigInt(Math.ceil((measureTx.serSize() * feePerKb) / 1000));
    }

    private _acceptTxBuilder(params: {
        covenantSk: Uint8Array;
        covenantPk: Uint8Array;
        fuelInputs: TxBuilderInput[];
        extraOutputs: TxBuilderOutput[];
    }) {
        return new TxBuilder({
            inputs: [
                ...params.fuelInputs,
                {
                    input: this.txBuilderInput,
                    signatory: AgoraOneshotSignatory(
                        params.covenantSk,
                        params.covenantPk,
                        this.variant.params.enforcedOutputs.length,
                    ),
                },
            ],
            outputs: [
                ...this.variant.params.enforcedOutputs,
                ...params.extraOutputs,
            ],
        });
    }

    /**
     * Build a tx canceling the offer.
     *
     * An offer can only be cancelled using the secret key that created it.
     *
     * `fuelInputs` must cover the tx fee, you can calculate it with cancelFeeSats.
     **/
    public cancelTx(params: {
        /** ECC object to sign signatures. */
        ecc: Ecc;
        /**
         * Cancel secret key of the offer, must be paired with the cancelPk of
         * the offer.
         **/
        cancelSk: Uint8Array;
        /**
         * Inputs fueling this tx with sats. Must have signatory and
         * input.signData set correctly. If it is set incorrectly, may fail
         * silently and build an invalid tx, failing at broadcast.
         *
         * The free sats of these inputs must be at least cancelFeeSats.
         **/
        fuelInputs: TxBuilderInput[];
        /** Script to send canceled tokens and the leftover sats (if any) to. */
        recipientScript: Script;
        /** Dust amount to use for the token output. */
        dustAmount?: number;
        /** Fee per kB to use when building the tx. */
        feePerKb?: number;
    }): Tx {
        const dustAmount = params.dustAmount ?? DEFAULT_DUST_LIMIT;
        const feePerKb = params.feePerKb ?? DEFAULT_FEE_PER_KB;
        const txBuild = this._cancelTxBuilder({
            cancelSk: params.cancelSk,
            fuelInputs: params.fuelInputs,
            extraOutputs: [
                {
                    value: dustAmount,
                    script: params.recipientScript,
                },
                params.recipientScript,
            ],
        });
        return txBuild.sign(params.ecc, feePerKb, dustAmount);
    }

    /**
     * How many extra satoshis are required to fuel cancelling this offer,
     * so the cancel tx can be broadcast on the network, excluding the asked
     * sats and a dust amount to receive the tokens.
     *
     * extraInputs can be used to add an ad input so we have the correct
     * estimate in case of a cancel + reoffer.
     *
     * This should be displayed to the user as cancellation network fee.
     * The total required sats input amount is returned by this function.
     **/
    public cancelFeeSats(params: {
        /** Script to send the tokens and the leftover sats (if any) to. */
        recipientScript: Script;
        /** Extra inputs */
        extraInputs?: TxBuilderInput[];
        /** Fee per kB to use when building the tx. */
        feePerKb?: number;
    }): bigint {
        const feePerKb = params.feePerKb ?? DEFAULT_FEE_PER_KB;
        const txBuild = this._cancelTxBuilder({
            cancelSk: new Uint8Array(32),
            fuelInputs: params.extraInputs ?? [],
            extraOutputs: [
                {
                    value: 0,
                    script: params.recipientScript,
                },
            ],
        });
        const measureTx = txBuild.sign(new EccDummy());
        return BigInt(Math.ceil((measureTx.serSize() * feePerKb) / 1000));
    }

    private _cancelTxBuilder(params: {
        cancelSk: Uint8Array;
        fuelInputs: TxBuilderInput[];
        extraOutputs: TxBuilderOutput[];
    }) {
        return new TxBuilder({
            inputs: [
                ...params.fuelInputs,
                {
                    input: this.txBuilderInput,
                    signatory: AgoraOneshotCancelSignatory(params.cancelSk),
                },
            ],
            outputs: [
                {
                    value: 0,
                    script: slpSend(
                        this.token.tokenId,
                        this.token.tokenType.number,
                        [BigInt(this.token.amount)],
                    ),
                },
                ...params.extraOutputs,
            ],
        });
    }

    /**
     * How many satoshis are asked to accept this offer, excluding tx fees.
     * This is what should be displayed to the user as the price.
     **/
    public askedSats(): bigint {
        return this.variant.params.askedSats();
    }
}

/**
 * Enables access to Agora, via Chronik instances that have the "agora" plugin
 * loaded.
 *
 * See agora.py.
 **/
export class Agora {
    private plugin: PluginEndpoint;

    /**
     * Create an Agora instance. The provided Chronik instance must have the
     * "agora" plugin loaded.
     **/
    public constructor(chronik: ChronikClient) {
        this.plugin = chronik.plugin(PLUGIN_NAME);
    }

    /**
     * Query all the token IDs, fungible and non-fungible ones, that have active
     * Agora offers.
     **/
    public async allOfferedTokenIds(): Promise<string[]> {
        return await this._allTokenIdsByPrefix(TOKEN_ID_PREFIX);
    }

    /** Query all fungible token IDs that have active Agora offers. */
    public async offeredFungibleTokenIds(): Promise<string[]> {
        return await this._allTokenIdsByPrefix(FUNGIBLE_TOKEN_ID_PREFIX);
    }

    /**
     * Query all token IDs of groups of non-fungible tokens that have active
     * Agora offers.
     **/
    public async offeredGroupTokenIds(): Promise<string[]> {
        return await this._allTokenIdsByPrefix(GROUP_TOKEN_ID_PREFIX);
    }

    /** Query all active offers by token ID. */
    public async activeOffersByTokenId(tokenId: string): Promise<AgoraOffer[]> {
        return await this._activeOffersByGroup(TOKEN_ID_PREFIX + tokenId);
    }

    /** Query all active offers by group token ID. */
    public async activeOffersByGroupTokenId(
        groupTokenId: string,
    ): Promise<AgoraOffer[]> {
        return await this._activeOffersByGroup(
            GROUP_TOKEN_ID_PREFIX + groupTokenId,
        );
    }

    /** Query all active offers with the given cancel pubkey. */
    public async activeOffersByPubKey(
        pubkeyHex: string,
    ): Promise<AgoraOffer[]> {
        return await this._activeOffersByGroup(PUBKEY_PREFIX + pubkeyHex);
    }

    private async _allTokenIdsByPrefix(prefixHex: string): Promise<string[]> {
        let tokenIds: string[] = [];
        let nextStart: string | undefined = undefined;
        while (nextStart !== '') {
            const groups = await this.plugin.groups(
                prefixHex,
                nextStart,
                PLUGIN_GROUPS_MAX_PAGE_SIZE,
            );
            tokenIds.push(
                ...groups.groups.map(({ group }) =>
                    group.substring(prefixHex.length),
                ),
            );
            nextStart = groups.nextStart;
        }
        return tokenIds;
    }

    private async _activeOffersByGroup(
        groupHex: string,
    ): Promise<AgoraOffer[]> {
        const utxos = await this.plugin.utxos(groupHex);
        return utxos.utxos.flatMap(utxo => {
            const offer = this._parseOfferUtxo(utxo);
            return offer ? [offer] : [];
        });
    }

    private _parseOfferUtxo(utxo: Utxo): AgoraOffer | undefined {
        if (utxo.plugins === undefined) {
            return undefined;
        }
        if (utxo.token?.tokenType.protocol !== 'SLP') {
            // Currently only SLP supported
            return undefined;
        }
        const plugin = utxo.plugins[PLUGIN_NAME];
        if (plugin === undefined) {
            return undefined;
        }
        const covenantVariant = plugin.data[0];
        if (covenantVariant !== ONESHOT_HEX) {
            // Unknown offer type
            return undefined;
        }
        const outputsSerHex = plugin.data[1];
        const outputsSerBytes = new Bytes(fromHex(outputsSerHex));
        const enforcedOutputs: TxOutput[] = [
            {
                value: BigInt(0),
                script: slpSend(
                    utxo.token.tokenId,
                    utxo.token.tokenType.number,
                    [0, BigInt(utxo.token.amount)],
                ),
            },
        ];
        while (outputsSerBytes.data.length > outputsSerBytes.idx) {
            enforcedOutputs.push(readTxOutput(outputsSerBytes));
        }
        const cancelPkGroupHex = plugin.groups.find(group =>
            group.startsWith(PUBKEY_PREFIX),
        );
        if (cancelPkGroupHex === undefined) {
            return undefined;
        }
        const cancelPk = fromHex(
            cancelPkGroupHex.substring(PUBKEY_PREFIX.length),
        );
        const agoraOneshot = new AgoraOneshot({
            enforcedOutputs,
            cancelPk,
        });
        return new AgoraOffer({
            variant: {
                type: 'ONESHOT',
                params: agoraOneshot,
            },
            outpoint: utxo.outpoint,
            txBuilderInput: {
                prevOut: utxo.outpoint,
                signData: {
                    value: utxo.value,
                    redeemScript: agoraOneshot.script(),
                },
            },
            token: utxo.token,
        });
    }
}