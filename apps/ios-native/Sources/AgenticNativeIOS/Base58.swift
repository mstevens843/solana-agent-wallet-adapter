import Foundation

enum Base58 {
    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)
    private static let indexes: [UInt8: Int] = {
        var map: [UInt8: Int] = [:]
        for (index, byte) in alphabet.enumerated() {
            map[byte] = index
        }
        return map
    }()

    static func encode(_ data: Data) -> String {
        if data.isEmpty {
            return ""
        }
        var digits = [Int](repeating: 0, count: data.count * 138 / 100 + 1)
        var length = 0

        for byte in data {
            var carry = Int(byte)
            var index = 0
            for digitIndex in stride(from: digits.count - 1, through: digits.count - length, by: -1) {
                carry += 256 * digits[digitIndex]
                digits[digitIndex] = carry % 58
                carry /= 58
                index += 1
            }
            while carry > 0 {
                let digitIndex = digits.count - index - 1
                digits[digitIndex] = carry % 58
                carry /= 58
                index += 1
            }
            length = index
        }

        var zeros = 0
        for byte in data {
            if byte == 0 {
                zeros += 1
            } else {
                break
            }
        }

        var result = String(repeating: "1", count: zeros)
        for digit in digits.suffix(length) {
            result.append(Character(UnicodeScalar(alphabet[digit])))
        }
        return result
    }

    static func decode(_ string: String) throws -> Data {
        if string.isEmpty {
            return Data()
        }
        let bytes = Array(string.utf8)
        var decoded = [UInt8](repeating: 0, count: bytes.count * 733 / 1000 + 1)
        var length = 0

        for byte in bytes {
            guard let value = indexes[byte] else {
                throw AgenticWalletError.invalidCallback("Invalid base58 character in wallet callback.")
            }
            var carry = value
            var index = 0
            for decodedIndex in stride(from: decoded.count - 1, through: decoded.count - length, by: -1) {
                carry += 58 * Int(decoded[decodedIndex])
                decoded[decodedIndex] = UInt8(carry & 0xff)
                carry >>= 8
                index += 1
            }
            while carry > 0 {
                let decodedIndex = decoded.count - index - 1
                decoded[decodedIndex] = UInt8(carry & 0xff)
                carry >>= 8
                index += 1
            }
            length = index
        }

        var zeros = 0
        for byte in bytes {
            if byte == alphabet[0] {
                zeros += 1
            } else {
                break
            }
        }

        var output = Data(repeating: 0, count: zeros)
        output.append(contentsOf: decoded.suffix(length))
        return output
    }
}
