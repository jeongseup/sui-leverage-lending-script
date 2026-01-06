# Sui Leverage Lending Script

This repository contains a set of scripts for interacting with the Leverage Lending protocol on the Sui blockchain. The scripts are written in TypeScript and use the Sui SDK to interact with the protocol.

## Installation

To install the dependencies, run the following command:

```bash
npm install
```

## Usage

The scripts in this repository are designed to be run as a Node.js application. To run a script, use the following command:

```bash
npm run test:<script-name>
```

For example, to run the flash loan script, use the following command:

```bash
npm run test:flash-loan
```

## Scripts

The following scripts are available:

- `test:flash-loan`: Runs a flash loan script.
- `test:flash-loan-dryrun`: Runs a flash loan script in dry run mode.
- `test:query-fees`: Queries the fees for a flash loan.
- `test:suilend-borrow`: Runs a Suilend borrow script.
- `test:suilend-deposit`: Runs a Suilend deposit script.
- `test:swap`: Runs a 7k swap script.

## References

- swap : https://github.com/7k-ag/7k-sdk-ts
- flashloan : https://github.com/scallop-io/sui-scallop-sdk
- lending : https://docs.suilend.fi/ecosystem/suilend-sdk-guide/getting-started-with-suilend-sdk
