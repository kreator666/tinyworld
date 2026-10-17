// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IDIDIdentity} from "./interfaces/IDIDIdentity.sol";

/// @title DIDValidation
/// @notice ERC-8004（Trustless Agents）Validation Registry 对齐实现。
/// - validationRequest 由 agent owner/operator 发起，指定 validator
/// - validationResponse 仅原请求的 validator 可提交，可多次调用更新结论
/// - 以 requestHash 为索引串联请求与响应（response 字段 0=未响应，1=通过，2=否决）
contract DIDValidation is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /// @notice 单条验证记录（请求 + 最新响应）
    struct Validation {
        uint256 agentId;
        address requester;
        address validator;
        string requestURI;
        bytes32 requestHash;
        uint8 response; // 0=未响应 / 1=validated / 2=invalidated
        string responseURI;
        bytes32 responseHash;
        string tag;
    }

    IDIDIdentity public identityRegistry;

    /// @dev requestHash => 验证记录
    mapping(bytes32 => Validation) private _validations;
    /// @dev agentId => requestHash 列表
    mapping(uint256 => bytes32[]) private _agentRequests;
    /// @dev validator => requestHash 列表
    mapping(address => bytes32[]) private _validatorRequests;

    error NotAgentOwnerOrOperator(address caller);
    error NotValidator(address caller);
    error RequestNotFound(bytes32 requestHash);
    error ZeroValidator();

    event ValidationRequest(
        uint256 indexed agentId, address indexed requester, address indexed validator, string requestURI, bytes32 requestHash
    );
    event ValidationResponse(
        bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address identityRegistry_) public initializer {
        __Ownable_init(msg.sender);
        identityRegistry = IDIDIdentity(identityRegistry_);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ==================================================================
    // 写路径
    // ==================================================================

    /// @notice 发起验证请求；仅 agent owner 或被授权 operator（权限位非 0）
    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash)
        external
    {
        if (validatorAddress == address(0)) revert ZeroValidator();
        address owner = identityRegistry.ownerOf(agentId); // 不存在的 agentId 在此 revert
        if (msg.sender != owner && identityRegistry.agentPermissions(agentId, msg.sender) == 0) {
            revert NotAgentOwnerOrOperator(msg.sender);
        }
        _validations[requestHash] = Validation({
            agentId: agentId,
            requester: msg.sender,
            validator: validatorAddress,
            requestURI: requestURI,
            requestHash: requestHash,
            response: 0,
            responseURI: "",
            responseHash: bytes32(0),
            tag: ""
        });
        _agentRequests[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);
        emit ValidationRequest(agentId, msg.sender, validatorAddress, requestURI, requestHash);
    }

    /// @notice 提交/更新验证结论；仅原请求的 validator，可多次调用（覆盖最新结论）
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        Validation storage v = _validations[requestHash];
        if (v.requestHash != requestHash) revert RequestNotFound(requestHash);
        if (msg.sender != v.validator) revert NotValidator(msg.sender);
        v.response = response;
        v.responseURI = responseURI;
        v.responseHash = responseHash;
        v.tag = tag;
        emit ValidationResponse(requestHash, response, responseURI, responseHash, tag);
    }

    // ==================================================================
    // 读路径
    // ==================================================================

    /// @notice 读取单条验证记录
    function getValidation(bytes32 requestHash) external view returns (Validation memory) {
        Validation memory v = _validations[requestHash];
        if (v.requestHash != requestHash) revert RequestNotFound(requestHash);
        return v;
    }

    /// @notice 验证状态速查（response: 0=未响应 / 1=通过 / 2=否决）
    function getValidationStatus(bytes32 requestHash) external view returns (uint8 response, bool exists) {
        Validation memory v = _validations[requestHash];
        exists = v.requestHash == requestHash;
        response = exists ? v.response : 0;
    }

    /// @notice 汇总：某 agent 在指定 validator 集合内、匹配 tag（空串=通配）的验证统计
    /// 返回 (validatedCount, invalidatedCount, pendingCount)
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint256 validatedCount, uint256 invalidatedCount, uint256 pendingCount)
    {
        bytes32[] storage hashes = _agentRequests[agentId];
        for (uint256 i = 0; i < hashes.length; ++i) {
            Validation storage v = _validations[hashes[i]];
            bool matchValidator = validatorAddresses.length == 0;
            for (uint256 k = 0; k < validatorAddresses.length; ++k) {
                if (v.validator == validatorAddresses[k]) {
                    matchValidator = true;
                    break;
                }
            }
            if (!matchValidator) continue;
            if (bytes(tag).length != 0 && keccak256(bytes(v.tag)) != keccak256(bytes(tag))) continue;
            if (v.response == 1) validatedCount += 1;
            else if (v.response == 2) invalidatedCount += 1;
            else pendingCount += 1;
        }
    }

    /// @notice 某 agent 的全部验证请求哈希
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentRequests[agentId];
    }

    /// @notice 某 validator 收到的全部验证请求哈希
    function getValidatorRequests(address validator) external view returns (bytes32[] memory) {
        return _validatorRequests[validator];
    }

    /// @notice 关联的 Identity Registry 地址
    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    /// @dev 存储槽位保留，未来追加状态变量时避免布局冲突
    uint256[50] private __gap;
}
