// Copyright (c) 2022 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef BITCOIN_AVALANCHE_COMPACTPROOFS_H
#define BITCOIN_AVALANCHE_COMPACTPROOFS_H

#include <avalanche/proof.h>
#include <avalanche/proofradixtreeadapter.h>

#include <radix.h>
#include <random.h>
#include <serialize.h>

#include <cstdint>
#include <ios>
#include <limits>
#include <utility>
#include <vector>

namespace avalanche {

namespace {
    struct TestCompactProofs;
}

struct ProofId;

struct PrefilledProof {
    // Used as an offset since last prefilled proof in CompactProofs
    uint32_t index;
    avalanche::ProofRef proof;

    class Formatter : public DifferenceFormatter {
    public:
        template <typename Stream> void Ser(Stream &s, PrefilledProof pp) {
            DifferenceFormatter::Ser(s, pp.index);
            s << pp.proof;
        }

        template <typename Stream> void Unser(Stream &s, PrefilledProof &pp) {
            DifferenceFormatter::Unser(s, pp.index);
            s >> pp.proof;
        }
    };
};

class CompactProofs {
private:
    uint64_t shortproofidk0, shortproofidk1;
    std::vector<uint64_t> shortproofids;
    std::vector<PrefilledProof> prefilledProofs;

public:
    static constexpr int SHORTPROOFIDS_LENGTH = 6;

    CompactProofs()
        : shortproofidk0(GetRand(std::numeric_limits<uint64_t>::max())),
          shortproofidk1(GetRand(std::numeric_limits<uint64_t>::max())) {}
    CompactProofs(const RadixTree<const Proof, ProofRadixTreeAdapter> &proofs);

    uint64_t getShortID(const ProofId &proofid) const;

    size_t size() const {
        return shortproofids.size() + prefilledProofs.size();
    }
    std::pair<uint64_t, uint64_t> getKeys() const {
        return std::make_pair(shortproofidk0, shortproofidk1);
    }

    SERIALIZE_METHODS(CompactProofs, obj) {
        READWRITE(
            obj.shortproofidk0, obj.shortproofidk1,
            Using<VectorFormatter<CustomUintFormatter<SHORTPROOFIDS_LENGTH>>>(
                obj.shortproofids),
            Using<VectorFormatter<PrefilledProof::Formatter>>(
                obj.prefilledProofs));

        if (ser_action.ForRead() && obj.prefilledProofs.size() > 0) {
            // Thanks to the DifferenceFormatter, the index values in the
            // deserialized prefilled proofs are absolute and sorted, so the
            // last vector item has the highest index value.
            uint64_t highestPrefilledIndex = obj.prefilledProofs.back().index;

            // Make sure the indexes do not overflow 32 bits.
            if (highestPrefilledIndex + obj.shortproofids.size() >
                std::numeric_limits<uint32_t>::max()) {
                throw std::ios_base::failure("indexes overflowed 32 bits");
            }

            // Make sure the indexes are contiguous. E.g. if there is no shortid
            // but 2 prefilled proofs with absolute indexes 0 and 2, then the
            // proof at index 1 cannot be recovered.
            if (highestPrefilledIndex >= obj.size()) {
                throw std::ios_base::failure("non contiguous indexes");
            }
        }
    }

private:
    friend struct ::avalanche::TestCompactProofs;
};

} // namespace avalanche

#endif // BITCOIN_AVALANCHE_COMPACTPROOFS_H
