require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'AgenticIosCapacitorBridge'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/mstevens843/solana-agent-wallet-adapter'
  s.author = 'Agentic'
  s.source = { :path => '.' }
  s.ios.deployment_target = '14.0'
  s.swift_version = '5.9'
  s.source_files = 'ios/Plugin/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.dependency 'Capacitor'
end
