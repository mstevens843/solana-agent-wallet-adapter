import Foundation

enum AgenticKeccak256 {
    private static let rateBytes = 136
    private static let outputBytes = 32

    static func hash(_ data: Data) -> Data {
        var state = [UInt64](repeating: 0, count: 25)
        let input = [UInt8](data)
        var offset = 0

        while offset + rateBytes <= input.count {
            absorb(Array(input[offset..<offset + rateBytes]), into: &state)
            permute(&state)
            offset += rateBytes
        }

        var finalBlock = [UInt8](repeating: 0, count: rateBytes)
        let remaining = input.count - offset
        if remaining > 0 {
            finalBlock.replaceSubrange(0..<remaining, with: input[offset..<input.count])
        }
        finalBlock[remaining] ^= 0x01
        finalBlock[rateBytes - 1] ^= 0x80
        absorb(finalBlock, into: &state)
        permute(&state)

        var out = Data()
        out.reserveCapacity(outputBytes)
        for index in 0..<outputBytes {
            let lane = state[index / 8]
            out.append(UInt8((lane >> UInt64((index % 8) * 8)) & 0xff))
        }
        return out
    }

    private static func absorb(_ block: [UInt8], into state: inout [UInt64]) {
        for laneIndex in 0..<(rateBytes / 8) {
            var lane: UInt64 = 0
            let base = laneIndex * 8
            for byteIndex in 0..<8 {
                lane |= UInt64(block[base + byteIndex]) << UInt64(byteIndex * 8)
            }
            state[laneIndex] ^= lane
        }
    }

    private static func rotateLeft(_ value: UInt64, by amount: UInt64) -> UInt64 {
        if amount == 0 { return value }
        return (value << amount) | (value >> (64 - amount))
    }

    private static func permute(_ state: inout [UInt64]) {
        let rotations: [UInt64] = [
            0, 1, 62, 28, 27,
            36, 44, 6, 55, 20,
            3, 10, 43, 25, 39,
            41, 45, 15, 21, 8,
            18, 2, 61, 56, 14,
        ]
        let roundConstants: [UInt64] = [
            0x0000000000000001, 0x0000000000008082,
            0x800000000000808A, 0x8000000080008000,
            0x000000000000808B, 0x0000000080000001,
            0x8000000080008081, 0x8000000000008009,
            0x000000000000008A, 0x0000000000000088,
            0x0000000080008009, 0x000000008000000A,
            0x000000008000808B, 0x800000000000008B,
            0x8000000000008089, 0x8000000000008003,
            0x8000000000008002, 0x8000000000000080,
            0x000000000000800A, 0x800000008000000A,
            0x8000000080008081, 0x8000000000008080,
            0x0000000080000001, 0x8000000080008008,
        ]

        for rc in roundConstants {
            var c = [UInt64](repeating: 0, count: 5)
            for x in 0..<5 {
                c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
            }
            for x in 0..<5 {
                let d = c[(x + 4) % 5] ^ rotateLeft(c[(x + 1) % 5], by: 1)
                for y in 0..<5 {
                    state[x + 5 * y] ^= d
                }
            }

            var b = [UInt64](repeating: 0, count: 25)
            for x in 0..<5 {
                for y in 0..<5 {
                    let source = x + 5 * y
                    let target = y + 5 * ((2 * x + 3 * y) % 5)
                    b[target] = rotateLeft(state[source], by: rotations[source])
                }
            }

            for x in 0..<5 {
                for y in 0..<5 {
                    state[x + 5 * y] = b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y]) & b[((x + 2) % 5) + 5 * y])
                }
            }

            state[0] ^= rc
        }
    }
}
