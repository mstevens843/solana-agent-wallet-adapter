import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class DeviceAgentProviderParserTests: XCTestCase {
    func testPricingKeywordsAreDetected() {
        XCTAssertTrue(AgenticCitationFilter.isPricingInstruction("what is the price of helium mobile"))
        XCTAssertTrue(AgenticCitationFilter.isPricingInstruction("check the monthly cost"))
        XCTAssertTrue(AgenticCitationFilter.isPricingInstruction("per month"))
        XCTAssertTrue(AgenticCitationFilter.isPricingInstruction("per-month"))
        XCTAssertTrue(AgenticCitationFilter.isPricingInstruction("approve if less than $5"))
        XCTAssertFalse(AgenticCitationFilter.isPricingInstruction("is this a real token mint"))
        XCTAssertFalse(AgenticCitationFilter.isPricingInstruction(""))
        XCTAssertFalse(AgenticCitationFilter.isPricingInstruction(nil))
    }

    func testDropsLowAuthoritySourcesOnlyOnPricingQuestions() {
        let citations = [
            AgenticCitation(url: "https://blog.heliummobile.com/zero-plan"),
            AgenticCitation(url: "https://news.vendor.com/article"),
            AgenticCitation(url: "https://medium.com/@user/post"),
            AgenticCitation(url: "https://author.substack.com/p/article"),
            AgenticCitation(url: "https://community.vendor.com/thread"),
            AgenticCitation(url: "https://forum.vendor.com/thread"),
            AgenticCitation(url: "https://www.heliummobile.com/plans", title: "Plans"),
        ]

        let pricing = AgenticCitationFilter.filterLowAuthorityCitations(
            citations,
            instructionText: "check helium mobile. lowest monthly plan. if less than $20. approve."
        )
        XCTAssertEqual(pricing.map(\.url), ["https://www.heliummobile.com/plans"])

        let nonPricing = AgenticCitationFilter.filterLowAuthorityCitations(
            citations,
            instructionText: "is this a real token mint"
        )
        XCTAssertEqual(nonPricing.count, citations.count)
    }

    func testExtractsOpenAIResponsesCitationsFromAnnotationsAndSources() throws {
        let payload = try json("""
        {
          "output": [
            {
              "type": "message",
              "content": [
                {
                  "type": "output_text",
                  "text": "a",
                  "annotations": [
                    { "type": "url_citation", "url": "https://example.com/a", "title": "A" },
                    { "type": "url_citation", "url": "https://example.com/b" }
                  ]
                }
              ]
            },
            {
              "type": "web_search_call",
              "action": {
                "sources": [
                  { "url": "https://example.com/c", "title": "C" }
                ]
              }
            }
          ]
        }
        """)
        let citations = AgenticProviderResponseParser.extractResponsesApiCitations(payload)
        XCTAssertEqual(citations.map(\.url), ["https://example.com/a", "https://example.com/b", "https://example.com/c"])
        XCTAssertEqual(citations.first?.title, "A")
    }

    func testExtractsGeminiGroundingCitations() throws {
        let payload = try json("""
        {
          "candidates": [
            {
              "groundingMetadata": {
                "groundingChunks": [
                  { "web": { "uri": "https://example.com/a", "title": "A" } },
                  { "web": { "uri": "https://example.com/b" } },
                  { "web": { "uri": "https://example.com/a", "title": "dupe" } }
                ]
              }
            }
          ]
        }
        """)
        let citations = AgenticProviderResponseParser.extractGeminiCitations(payload)
        XCTAssertEqual(citations.map(\.url), ["https://example.com/a", "https://example.com/b"])
        XCTAssertEqual(citations.first?.title, "A")
    }

    func testExtractsAnthropicCitations() throws {
        let payload = try json("""
        {
          "content": [
            {
              "type": "text",
              "text": "hello",
              "citations": [
                { "type": "web_search_result_location", "url": "https://example.com/a", "title": "A", "cited_text": "snippet" }
              ]
            },
            {
              "type": "text",
              "text": "world",
              "citations": [
                { "type": "web_search_result_location", "url": "https://example.com/b" },
                { "type": "web_search_result_location", "url": "https://example.com/a", "title": "dupe" }
              ]
            }
          ]
        }
        """)
        let citations = AgenticProviderResponseParser.extractAnthropicCitations(payload)
        XCTAssertEqual(citations.map(\.url), ["https://example.com/a", "https://example.com/b"])
        XCTAssertEqual(citations.first?.citedText, "snippet")
    }

    func testResearchEvidenceSuppressesPricingSummaryWhenOnlyBlogSourcesReturned() throws {
        let raw = try json("""
        {
          "output_text": "Helium Mobile has a $0 plan.",
          "output": [
            {
              "type": "message",
              "content": [
                {
                  "type": "output_text",
                  "text": "Helium Mobile has a $0 plan.",
                  "annotations": [
                    { "type": "url_citation", "url": "https://blog.heliummobile.com/zero-plan", "title": "Zero Plan" }
                  ]
                }
              ]
            }
          ]
        }
        """)

        let evidence = AgenticAgentProviderSupport.researchEvidence(
            provider: "OpenAI",
            summary: "Helium Mobile has a $0 plan.",
            raw: raw,
            instructionText: "check helium mobile. lowest monthly plan. if less than $20. approve."
        )

        XCTAssertEqual(evidence["summary"] as? String, "Current pricing could not be verified against an official source. Ask the user to confirm the plan name and price.")
        XCTAssertEqual(evidence["sourceWarning"] as? String, "pricing_unverified_official_source")
        XCTAssertEqual(evidence["droppedLowAuthoritySourceCount"] as? Int, 1)
        XCTAssertEqual((evidence["sources"] as? [[String: Any]])?.count, 0)
    }

    func testParseModelJsonAcceptsEmbeddedJson() {
        let parsed = AgenticProviderResponseParser.parseModelJson("""
        Here is the plan:
        {"intent":"transfer SOL","route":"system","risk":"low","approval":"once","safeguards":["confirm recipient"]}
        Let me know.
        """)
        XCTAssertEqual(parsed?["intent"] as? String, "transfer SOL")
    }

    private func json(_ text: String) throws -> [String: Any] {
        let data = try XCTUnwrap(text.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data, options: []) as? [String: Any])
    }
}
