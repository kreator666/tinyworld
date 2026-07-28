// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IERC5192 — Minimal Soulbound NFT interface (EIP-5192 final)
interface IERC5192 {
    /// @notice Emitted when the locking status is changed to locked.
    event Locked(uint256 tokenId);

    /// @notice Emitted when the locking status is changed to unlocked.
    event Unlocked(uint256 tokenId);

    /// @notice Returns the locking status of an Soulbound Token
    function locked(uint256 tokenId) external view returns (bool);
}
