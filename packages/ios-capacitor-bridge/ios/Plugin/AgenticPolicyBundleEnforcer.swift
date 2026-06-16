import Foundation

/// Foundation-only policy bundle safety enforcement shared by the iOS plugin and SwiftPM tests.
enum AgenticPolicyBundleEnforcer {
    /// Inspect the LLM review result alongside the request payload. If the
    /// bundle had blocking failures and the LLM returned approve, downgrade to
    /// deny and surface the failing atom ids. If non-English policy text could
    /// not be safely canonicalized, force needs_input.
    static func enforce(reviewResult: [String: Any], payload: [String: Any]) -> [String: Any] {
        guard let bundle = extractBundle(from: payload) else { return reviewResult }
        let parsed: [String: Any]
        let text = reviewResult["text"] as? String
        if let text {
            guard let textData = text.data(using: .utf8),
                  let parsedText = try? JSONSerialization.jsonObject(with: textData, options: []) as? [String: Any] else {
                return reviewResult
            }
            parsed = parsedText
        } else {
            parsed = reviewResult
        }
        var corrected = mergePolicyFindings(into: parsed, bundle: bundle)
        if languageRequiresInput(bundle: bundle) {
            let reason = "Agentic could not safely translate this non-English policy rule. Rephrase it or provide the rule in English before approval."
            corrected["decision"] = "needs_input"
            corrected["reason"] = reason
            corrected["missingFactIds"] = ["policy.language.canonicalization"]
            var evidence = corrected["evidence"] as? [String: Any] ?? [:]
            evidence["language"] = bundle["language"] as? [String: Any] ?? [:]
            evidence["languageSafetyApplied"] = true
            evidence["serverSafetyApplied"] = true
            corrected["evidence"] = evidence
            var out = writeBack(original: reviewResult, parsed: corrected, hadTextEnvelope: text != nil)
            out["safetyOverride"] = [
                "reason": "policy_language_canonicalization_failed",
                "enforcedDecision": "needs_input",
            ]
            return out
        }
        guard let blocking = bundle["hasBlockingFailure"] as? Bool, blocking == true else {
            return writeBack(original: reviewResult, parsed: corrected, hadTextEnvelope: text != nil)
        }
        let decision = (parsed["decision"] as? String)?.lowercased()
        guard decision == "approve" else {
            return writeBack(original: reviewResult, parsed: corrected, hadTextEnvelope: text != nil)
        }

        let validAtomIds = validAtomIds(from: bundle)
        let evaluations = bundle["evaluations"] as? [[String: Any]] ?? []
        let failing = evaluations.filter {
            ($0["pass"] as? Bool) == false && validAtomIds.contains($0["atomId"] as? String ?? "")
        }
        let blockingFactIds = failing.compactMap { $0["atomId"] as? String }
        let firstLabel = (failing.first?["finding"] as? [String: Any])?["label"] as? String
        let reason = firstLabel.map { "User policy bundle failed: \($0)" }
            ?? "User policy bundle has at least one failing rule."

        corrected["decision"] = "deny"
        corrected["reason"] = reason
        corrected["blockingFactIds"] = blockingFactIds

        var out = writeBack(original: reviewResult, parsed: corrected, hadTextEnvelope: text != nil)
        out["safetyOverride"] = [
            "reason": "policy_bundle_blocking_failure",
            "originalDecision": "approve",
            "enforcedDecision": "deny",
            "blockingFactIds": blockingFactIds,
        ]
        return out
    }

    private static func extractBundle(from payload: [String: Any]) -> [String: Any]? {
        guard let context = payload["context"] as? [String: Any] else { return nil }
        return context["policyBundle"] as? [String: Any]
    }

    private static func writeBack(original: [String: Any], parsed: [String: Any], hadTextEnvelope: Bool) -> [String: Any] {
        if hadTextEnvelope {
            var out = original
            if let data = try? JSONSerialization.data(withJSONObject: parsed, options: [.sortedKeys]),
               let text = String(data: data, encoding: .utf8) {
                out["text"] = text
            }
            return out
        }
        return parsed
    }

    private static func validAtomIds(from bundle: [String: Any]) -> Set<String> {
        let atoms = bundle["atoms"] as? [[String: Any]] ?? []
        let atomIds = Set(atoms.compactMap { $0["id"] as? String }.filter { !$0.isEmpty })
        if !atomIds.isEmpty {
            return atomIds
        }
        let evaluations = bundle["evaluations"] as? [[String: Any]] ?? []
        return Set(evaluations.compactMap { $0["atomId"] as? String }.filter { !$0.isEmpty })
    }

    private static func languageRequiresInput(bundle: [String: Any]) -> Bool {
        guard let language = bundle["language"] as? [String: Any] else { return false }
        if (language["requiresInput"] as? Bool) == true { return true }
        return (language["canonicalizationStatus"] as? String) == "failed"
    }

    private static func mergePolicyFindings(into reviewResult: [String: Any], bundle: [String: Any]) -> [String: Any] {
        let atoms = bundle["atoms"] as? [[String: Any]] ?? []
        let validAtomIds = validAtomIds(from: bundle)
        let evaluations = bundle["evaluations"] as? [[String: Any]] ?? []
        guard !evaluations.isEmpty else { return reviewResult }

        var out = reviewResult
        var evidence = out["evidence"] as? [String: Any] ?? [:]
        var findings = evidence["findings"] as? [[String: Any]] ?? []
        var labelIndex: [String: Int] = [:]
        for (idx, finding) in findings.enumerated() {
            if let label = (finding["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
               !label.isEmpty {
                labelIndex[label] = idx
            }
        }

        var factIds = out["evidenceFactIds"] as? [String] ?? []
        var seenFactIds = Set(factIds)
        let largeBundle = evaluations.count > 3
        for evaluation in evaluations {
            guard let atomId = evaluation["atomId"] as? String, validAtomIds.contains(atomId) else { continue }
            if largeBundle, (evaluation["unresolved"] as? Bool) == true { continue }
            guard let finding = evaluation["finding"] as? [String: Any],
                  let rawLabel = finding["label"] as? String else { continue }
            let label = rawLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            if label.isEmpty { continue }
            if !seenFactIds.contains(atomId) {
                factIds.append(atomId)
                seenFactIds.insert(atomId)
            }
            let row: [String: Any] = [
                "label": label,
                "value": finding["value"] as? String ?? "",
                "tone": finding["tone"] as? String ?? "neutral",
                "atomId": atomId,
            ]
            let key = label.lowercased()
            if let idx = labelIndex[key] {
                findings[idx] = row
            } else {
                findings.append(row)
                labelIndex[key] = findings.count - 1
            }
        }
        evidence["findings"] = findings
        evidence["policyAtoms"] = atoms.map {
            [
                "id": $0["id"] as? String ?? "",
                "type": $0["type"] as? String ?? "",
                "rawText": $0["rawText"] as? String ?? "",
            ]
        }
        if let txGateOutcomes = bundle["txGateOutcomes"] as? [String: Any], !txGateOutcomes.isEmpty {
            evidence["policyTxGates"] = txGateOutcomes
        }
        out["evidence"] = evidence
        out["evidenceFactIds"] = factIds
        return out
    }
}
