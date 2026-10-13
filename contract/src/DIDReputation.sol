// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDIDIdentity} from "./interfaces/IDIDIdentity.sol";

/// @title DIDReputation
/// @notice ERC-8004（Trustless Agents）Reputation Registry 对齐实现。
/// - 反馈按 (agentId, clientAddress) 分桶存储，feedbackIndex 为桶内序号
/// - endpoint / feedbackURI / feedbackHash 只发事件不落存储（省 gas）；读链由事件索引承担
/// - 提交者不能是 agent owner 或其授权 operator（防自评）
contract DIDReputation {
    /// @notice 单条反馈（ERC-8004 Feedback 结构；endpoint/feedbackURI/feedbackHash 事件专用）
    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool isRevoked;
        uint128 feedbackIndex;
        uint128 responseCount;
        address clientAddress;
    }

    uint8 public constant MAX_VALUE_DECIMALS = 18;

    IDIDIdentity public immutable identityRegistry;

    /// @dev agentId => client => 反馈桶
    mapping(uint256 => mapping(address => Feedback[])) private _feedbacks;
    /// @dev agentId => 已反馈过的客户端集合（getClients 用；首次反馈时登记）
    mapping(uint256 => address[]) private _clients;
    mapping(uint256 => mapping(address => bool)) private _clientSeen;

    error InvalidValueDecimals(uint8 valueDecimals);
    error AgentOwnerCannotFeedback();
    error InvalidFeedbackIndex(uint256 agentId, address clientAddress, uint128 feedbackIndex);
    error NotFeedbackAuthor(address caller);
    error EmptyClientAddresses();

    /// @notice ERC-8004：新反馈事件（tag1 建索引便于按维度检索）
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        int128 value,
        uint8 valueDecimals,
        string indexed tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint128 feedbackIndex);
    event ResponseAppended(
        uint256 indexed agentId, address indexed clientAddress, uint128 indexed feedbackIndex, string responseURI, bytes32 responseHash
    );

    constructor(address identityRegistry_) {
        identityRegistry = IDIDIdentity(identityRegistry_);
    }

    // ==================================================================
    // 写路径（giveFeedback 保持轻量：一次 push + 一次事件）
    // ==================================================================

    /// @notice 提交对某 agent 的反馈；提交者不能是 agent owner/operator
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        if (valueDecimals > MAX_VALUE_DECIMALS) revert InvalidValueDecimals(valueDecimals);
        _checkNotOwnerOrOperator(agentId);
        Feedback[] storage bucket = _feedbacks[agentId][msg.sender];
        uint128 index = uint128(bucket.length);
        bucket.push();
        Feedback storage fb = bucket[index];
        fb.value = value;
        fb.valueDecimals = valueDecimals;
        fb.tag1 = tag1;
        fb.tag2 = tag2;
        fb.feedbackIndex = index;
        fb.clientAddress = msg.sender;
        if (!_clientSeen[agentId][msg.sender]) {
            _clientSeen[agentId][msg.sender] = true;
            _clients[agentId].push(msg.sender);
        }
        emit NewFeedback(agentId, msg.sender, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash);
    }

    /// @dev 提交者不能是 agent owner 或其授权 operator（防自评）；顺带校验 agentId 存在
    function _checkNotOwnerOrOperator(uint256 agentId) internal view {
        address owner = identityRegistry.ownerOf(agentId);
        if (msg.sender == owner || identityRegistry.agentPermissions(agentId, msg.sender) != 0) {
            revert AgentOwnerCannotFeedback();
        }
    }

    /// @notice 撤回自己的反馈（标记 isRevoked，不删除，保索引稳定）
    function revokeFeedback(uint256 agentId, uint128 feedbackIndex) external {
        Feedback[] storage bucket = _feedbacks[agentId][msg.sender];
        if (feedbackIndex >= bucket.length) {
            revert InvalidFeedbackIndex(agentId, msg.sender, feedbackIndex);
        }
        Feedback storage fb = bucket[feedbackIndex];
        if (fb.clientAddress != msg.sender) revert NotFeedbackAuthor(msg.sender);
        fb.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    /// @notice 反馈作者追加回应（如申诉/补充说明）；只计数以省 gas
    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint128 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        Feedback[] storage bucket = _feedbacks[agentId][clientAddress];
        if (feedbackIndex >= bucket.length) {
            revert InvalidFeedbackIndex(agentId, clientAddress, feedbackIndex);
        }
        if (msg.sender != clientAddress) revert NotFeedbackAuthor(msg.sender);
        bucket[feedbackIndex].responseCount += 1;
        emit ResponseAppended(agentId, clientAddress, feedbackIndex, responseURI, responseHash);
    }

    // ==================================================================
    // 读路径
    // ==================================================================

    /// @notice 读单条反馈
    function readFeedback(uint256 agentId, address clientAddress, uint128 feedbackIndex)
        external
        view
        returns (Feedback memory)
    {
        Feedback[] storage bucket = _feedbacks[agentId][clientAddress];
        if (feedbackIndex >= bucket.length) {
            revert InvalidFeedbackIndex(agentId, clientAddress, feedbackIndex);
        }
        return bucket[feedbackIndex];
    }

    /// @notice 按多客户端批量读反馈（spec：每客户端各取 [startIndex, startIndex+count) 段）
    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        uint128[] calldata startIndexes,
        uint128[] calldata counts
    )
        external
        view
        returns (
            Feedback[] memory feedbacks,
            address[] memory clients,
            uint128[] memory actualStartIndexes,
            uint128[] memory actualCounts
        )
    {
        uint256 n = clientAddresses.length;
        clients = new address[](n);
        actualStartIndexes = new uint128[](n);
        actualCounts = new uint128[](n);
        uint256 total;
        for (uint256 i = 0; i < n; ++i) {
            uint256 len = _feedbacks[agentId][clientAddresses[i]].length;
            uint128 start = startIndexes[i];
            uint128 want = counts[i];
            uint128 actual = start < len ? (start + want > len ? uint128(len - start) : want) : 0;
            clients[i] = clientAddresses[i];
            actualStartIndexes[i] = start;
            actualCounts[i] = actual;
            total += actual;
        }
        feedbacks = new Feedback[](total);
        uint256 offset;
        for (uint256 i = 0; i < n; ++i) {
            Feedback[] storage bucket = _feedbacks[agentId][clientAddresses[i]];
            for (uint128 k = 0; k < actualCounts[i]; ++k) {
                feedbacks[offset + k] = bucket[actualStartIndexes[i] + k];
            }
            offset += actualCounts[i];
        }
    }

    /// @notice 汇总：指定客户端集合内、匹配 tag 过滤（空串=通配）的未撤回反馈平均值。
    /// 返回值统一换算到 18 位小数；clientAddresses 必填非空。
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (int256 averageValue, uint8 valueDecimals, uint256 numFeedbacks)
    {
        if (clientAddresses.length == 0) revert EmptyClientAddresses();
        int256 sum;
        uint256 count;
        for (uint256 i = 0; i < clientAddresses.length; ++i) {
            Feedback[] storage bucket = _feedbacks[agentId][clientAddresses[i]];
            for (uint256 k = 0; k < bucket.length; ++k) {
                Feedback storage fb = bucket[k];
                if (fb.isRevoked) continue;
                if (bytes(tag1).length != 0 && ! _strEq(fb.tag1, tag1)) continue;
                if (bytes(tag2).length != 0 && !_strEq(fb.tag2, tag2)) continue;
                // 统一抬到 18 位小数求和（valueDecimals ≤ 18，指数非负）
                sum += int256(fb.value) * int256(10 ** uint256(18 - fb.valueDecimals));
                count += 1;
            }
        }
        numFeedbacks = count;
        valueDecimals = 18;
        averageValue = count == 0 ? int256(0) : sum / int256(count);
    }

    /// @notice 某 agent 的全部反馈客户端列表
    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    /// @notice 某客户端对某 agent 的最新反馈序号（无反馈时为 0）
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint128) {
        return uint128(_feedbacks[agentId][clientAddress].length);
    }

    /// @notice 关联的 Identity Registry 地址
    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    function _strEq(string storage a, string memory b) internal view returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
