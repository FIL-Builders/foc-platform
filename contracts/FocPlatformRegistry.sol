// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

contract FocPlatformRegistry {
    enum UploadStatus {
        None,
        Requested,
        Uploading,
        Committed,
        Partial,
        Failed,
        Cancelled,
        Expired,
        Deleted
    }

    enum UploadFinalizationStatus {
        Committed,
        Partial,
        Failed
    }

    struct RequestUploadParams {
        bytes32 accountId;
        address user;
        bytes32 idempotencyKey;
        bytes32 contentHash;
        bytes32 metadataHash;
        uint64 size;
        uint8 requestedCopies;
        bool withCDN;
        uint256 maxCost;
        uint64 requestExpiresAt;
    }

    struct StorageObject {
        uint256 objectId;
        bytes32 accountId;
        address user;
        bytes32 idempotencyKey;
        bytes32 contentHash;
        bytes32 metadataHash;
        bytes32 pieceCidHash;
        uint64 size;
        uint8 requestedCopies;
        uint8 completedCopies;
        bool withCDN;
        uint256 maxCost;
        uint256 reservedCost;
        uint256 actualCost;
        UploadStatus status;
        address coordinator;
        uint64 requestExpiresAt;
        uint64 createdAt;
        uint64 updatedAt;
        bytes32 receiptHash;
    }

    struct AccountUsage {
        uint256 activeBytes;
        uint256 activeObjects;
        uint256 pendingBytes;
        uint256 reservedCost;
        uint256 totalActualCost;
        uint256 totalUploadedBytes;
        uint256 totalRequestedUploads;
        uint256 totalFinalizedUploads;
        uint256 totalFailedUploads;
    }

    struct CopyReceipt {
        uint256 providerId;
        uint256 datasetId;
        uint256 pieceId;
        bytes32 addPieceTxHash;
        bytes32 retrievalUrlHash;
        bool isNewDataSet;
    }

    struct UploadReceipt {
        UploadFinalizationStatus finalizationStatus;
        address payer;
        bytes32 pieceCidHash;
        uint64 size;
        uint8 requestedCopies;
        uint8 completedCopies;
        uint256 actualCost;
        bytes32 receiptHash;
        CopyReceipt[] copies;
    }

    struct CoordinatorPolicy {
        bool allowed;
        uint64 maxFinalizeDelay;
        uint64 sessionKeyExpiresAt;
        bytes32 permissionsHash;
    }

    struct DatasetRecord {
        bytes32 accountId;
        address payer;
        uint256 providerId;
        uint256 datasetId;
        bytes32 storageClass;
        bool withCDN;
        uint64 createdAt;
        uint64 updatedAt;
    }

    struct DatasetKey {
        bytes32 accountId;
        uint256 providerId;
        uint256 datasetId;
    }

    struct PolicyConfig {
        bool paused;
        uint64 maxObjectSize;
        uint8 maxCopies;
        uint256 maxCostPerUpload;
        uint256 maxActiveBytesPerAccount;
        uint32 defaultRequestTtl;
        bool allowFailureCharges;
    }

    event UploadRequested(
        uint256 indexed objectId,
        bytes32 indexed accountId,
        address indexed user,
        bytes32 idempotencyKey,
        bytes32 contentHash,
        bytes32 metadataHash,
        uint64 size,
        uint8 requestedCopies,
        bool withCDN,
        uint256 maxCost,
        uint64 requestExpiresAt
    );
    event UploadStarted(uint256 indexed objectId, address indexed coordinator, uint64 startedAt);
    event UploadFinalized(
        uint256 indexed objectId,
        bytes32 indexed accountId,
        UploadFinalizationStatus finalizationStatus,
        bytes32 pieceCidHash,
        uint8 completedCopies,
        uint256 actualCost,
        bytes32 receiptHash
    );
    event ReceiptPayerRecorded(
        uint256 indexed objectId, bytes32 indexed accountId, address indexed payer
    );
    event CopyRecorded(
        uint256 indexed objectId,
        uint256 indexed providerId,
        uint256 indexed datasetId,
        uint256 pieceId,
        bytes32 addPieceTxHash,
        bytes32 retrievalUrlHash,
        bool isNewDataSet
    );
    event UploadFailed(
        uint256 indexed objectId, bytes32 indexed accountId, bytes32 reasonHash, uint256 chargedCost
    );
    event UploadCancelled(uint256 indexed objectId, bytes32 indexed accountId);
    event UploadExpired(uint256 indexed objectId, bytes32 indexed accountId);
    event UsageReserved(
        bytes32 indexed accountId,
        uint256 indexed objectId,
        uint256 reservedCost,
        uint256 activeBytesBefore
    );
    event UsageFinalized(
        bytes32 indexed accountId,
        uint256 indexed objectId,
        uint256 actualCost,
        uint256 activeBytesDelta
    );
    event UsageReleased(bytes32 indexed accountId, uint256 indexed objectId, uint256 releasedCost);
    event CoordinatorUpdated(
        address indexed coordinator,
        bool allowed,
        uint64 maxFinalizeDelay,
        uint64 sessionKeyExpiresAt,
        bytes32 permissionsHash
    );
    event PolicyUpdated(bytes32 indexed configHash);
    event DatasetRecorded(
        bytes32 indexed accountId,
        uint256 indexed providerId,
        uint256 indexed datasetId,
        address payer,
        bytes32 storageClass,
        bool withCDN
    );
    event RelayerUpdated(address indexed relayer, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error InvalidAccount();
    error InvalidUser();
    error InvalidPolicy();
    error InvalidSignature();
    error UnauthorizedCoordinator(address caller);
    error UnauthorizedCaller(address caller);
    error Paused();
    error RequestExpired(uint256 objectId);
    error RequestNotExpired(uint256 objectId);
    error TerminalUploadStatus(uint256 objectId, UploadStatus status);
    error InvalidUploadStatus(uint256 objectId, UploadStatus expected, UploadStatus actual);
    error DuplicateIdempotencyKey(
        bytes32 accountId, bytes32 idempotencyKey, uint256 existingObjectId
    );
    error CostExceedsMaximum(uint256 actualCost, uint256 maxCost);
    error RequestedCopyCountMismatch(uint8 receiptRequestedCopies, uint8 objectRequestedCopies);
    error CopyCountMismatch(uint8 completedCopies, uint256 expectedCopies);
    error ReceiptSizeMismatch(uint64 receiptSize, uint64 objectSize);
    error InvalidPayer();
    error ZeroReceiptHash();
    error ListLimitExceeded(uint256 limit, uint256 maxLimit);
    error ReadBatchCallFailed(uint256 index, bytes returnData);
    error ActiveCursorTraversalLimitExceeded(uint256 cursorIdExclusive, uint256 maxSteps);

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("FocPlatformRegistry");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant REQUEST_UPLOAD_TYPEHASH = keccak256(
        "RequestUpload(bytes32 accountId,address user,bytes32 idempotencyKey,bytes32 contentHash,bytes32 metadataHash,uint64 size,uint8 requestedCopies,bool withCDN,uint256 maxCost,uint64 requestExpiresAt,address registry,uint256 chainId)"
    );
    uint256 private constant SECP256K1N_HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 public constant MAX_LIST_LIMIT = 50;

    address public owner;
    uint256 public nextObjectId = 1;
    PolicyConfig public policy;

    mapping(uint256 => StorageObject) private _objects;
    mapping(uint256 => CopyReceipt[]) private _copyReceipts;
    mapping(uint256 => address) private _receiptPayers;
    mapping(bytes32 => AccountUsage) private _usage;
    mapping(bytes32 => mapping(bytes32 => uint256)) private _objectByIdempotencyKey;
    mapping(address => CoordinatorPolicy) public coordinatorPolicies;
    mapping(address => bool) private _relayers;
    mapping(bytes32 => mapping(uint256 => mapping(uint256 => DatasetRecord))) private _datasets;
    bytes32[] private _accountIds;
    mapping(bytes32 => bool) private _knownAccountIds;
    mapping(bytes32 => uint256) private _accountObjectHeads;
    mapping(uint256 => uint256) private _accountObjectNext;
    uint256 private _activeObjectHead;
    uint256 private _activeObjectCount;
    mapping(uint256 => bool) private _activeObjectIndexed;
    mapping(uint256 => uint256) private _activeObjectPrev;
    mapping(uint256 => uint256) private _activeObjectNext;
    mapping(bytes32 => uint256) private _accountActiveObjectHeads;
    mapping(uint256 => uint256) private _accountActiveObjectPrev;
    mapping(uint256 => uint256) private _accountActiveObjectNext;
    address[] private _coordinatorAddresses;
    mapping(address => bool) private _knownCoordinatorAddresses;
    address[] private _relayerAddresses;
    mapping(address => bool) private _knownRelayerAddresses;
    DatasetKey[] private _datasetKeys;
    mapping(bytes32 => mapping(uint256 => mapping(uint256 => bool))) private _knownDatasetKeys;

    modifier onlyOwner() {
        if (msg.sender != owner) revert UnauthorizedCaller(msg.sender);
        _;
    }

    constructor() {
        owner = msg.sender;
        policy = PolicyConfig({
            paused: false,
            maxObjectSize: type(uint64).max,
            maxCopies: 10,
            maxCostPerUpload: type(uint128).max,
            maxActiveBytesPerAccount: type(uint128).max,
            defaultRequestTtl: 1 days,
            allowFailureCharges: false
        });
        emit OwnershipTransferred(address(0), msg.sender);
        emit PolicyUpdated(_policyHash(policy));
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert UnauthorizedCaller(newOwner);
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function requestUpload(RequestUploadParams calldata params, bytes calldata userSignature)
        external
        returns (uint256 objectId)
    {
        if (policy.paused) revert Paused();
        _validateRequestPolicy(params);
        _authorizeRequest(params, userSignature);

        uint64 expiresAt = params.requestExpiresAt;
        if (expiresAt == 0) {
            expiresAt = uint64(block.timestamp) + policy.defaultRequestTtl;
        }
        if (expiresAt <= block.timestamp) revert RequestExpired(0);

        uint256 existing = _objectByIdempotencyKey[params.accountId][params.idempotencyKey];
        if (existing != 0) {
            revert DuplicateIdempotencyKey(params.accountId, params.idempotencyKey, existing);
        }

        AccountUsage storage usage = _usage[params.accountId];
        uint256 activeBytesBefore = usage.activeBytes;
        uint256 requestedBytes = _requestedBytes(params.size, params.requestedCopies);
        if (
            usage.activeBytes + usage.pendingBytes + requestedBytes
                > policy.maxActiveBytesPerAccount
        ) {
            revert InvalidPolicy();
        }

        objectId = nextObjectId++;
        _objectByIdempotencyKey[params.accountId][params.idempotencyKey] = objectId;

        _storeRequestedObject(objectId, params, expiresAt);
        _indexRequestedObject(objectId, params.accountId);

        usage.reservedCost += params.maxCost;
        usage.pendingBytes += requestedBytes;
        usage.totalRequestedUploads += 1;

        emit UsageReserved(params.accountId, objectId, params.maxCost, activeBytesBefore);
        _emitUploadRequested(objectId, expiresAt, params);
    }

    function startUpload(uint256 objectId) external {
        _requireActiveCoordinator();
        StorageObject storage objectRef = _requireMutableObject(objectId);
        if (objectRef.status != UploadStatus.Requested) {
            revert InvalidUploadStatus(objectId, UploadStatus.Requested, objectRef.status);
        }
        _requireNotExpired(objectRef);

        objectRef.status = UploadStatus.Uploading;
        objectRef.coordinator = msg.sender;
        objectRef.updatedAt = uint64(block.timestamp);

        emit UploadStarted(objectId, msg.sender, uint64(block.timestamp));
    }

    function finalizeUpload(uint256 objectId, UploadReceipt calldata receipt) external {
        _requireActiveCoordinator();
        StorageObject storage objectRef = _requireMutableObject(objectId);
        _requireNotExpired(objectRef);
        _validateReceipt(objectRef, receipt);

        UploadStatus finalStatus = _statusFromReceipt(objectRef, receipt);
        objectRef.status = finalStatus;
        objectRef.coordinator = msg.sender;
        objectRef.pieceCidHash = receipt.pieceCidHash;
        objectRef.completedCopies = receipt.completedCopies;
        objectRef.actualCost = receipt.actualCost;
        objectRef.receiptHash = receipt.receiptHash;
        objectRef.updatedAt = uint64(block.timestamp);
        _receiptPayers[objectId] = receipt.payer;
        _removeActiveObject(objectRef);

        AccountUsage storage usage = _usage[objectRef.accountId];
        uint256 releasedCost = objectRef.reservedCost - receipt.actualCost;
        _releasePendingBytes(usage, objectRef);
        usage.reservedCost -= objectRef.reservedCost;
        usage.totalActualCost += receipt.actualCost;

        uint256 activeBytesDelta;
        if (finalStatus == UploadStatus.Committed || finalStatus == UploadStatus.Partial) {
            activeBytesDelta = uint256(objectRef.size) * receipt.completedCopies;
            if (usage.activeBytes + activeBytesDelta > policy.maxActiveBytesPerAccount) {
                revert InvalidPolicy();
            }
            usage.activeBytes += activeBytesDelta;
            usage.activeObjects += 1;
            usage.totalUploadedBytes += activeBytesDelta;
            usage.totalFinalizedUploads += 1;
        } else {
            usage.totalFailedUploads += 1;
        }

        for (uint256 i = 0; i < receipt.copies.length; i++) {
            _copyReceipts[objectId].push(receipt.copies[i]);
            emit CopyRecorded(
                objectId,
                receipt.copies[i].providerId,
                receipt.copies[i].datasetId,
                receipt.copies[i].pieceId,
                receipt.copies[i].addPieceTxHash,
                receipt.copies[i].retrievalUrlHash,
                receipt.copies[i].isNewDataSet
            );
        }

        emit UsageReleased(objectRef.accountId, objectId, releasedCost);
        emit UsageFinalized(objectRef.accountId, objectId, receipt.actualCost, activeBytesDelta);
        emit ReceiptPayerRecorded(objectId, objectRef.accountId, receipt.payer);
        emit UploadFinalized(
            objectId,
            objectRef.accountId,
            receipt.finalizationStatus,
            receipt.pieceCidHash,
            receipt.completedCopies,
            receipt.actualCost,
            receipt.receiptHash
        );
    }

    function failUpload(uint256 objectId, bytes32 reasonHash, uint256 chargedCost) external {
        _requireActiveCoordinator();
        StorageObject storage objectRef = _requireMutableObject(objectId);
        _requireNotExpired(objectRef);
        _validateFailureCharge(objectRef.reservedCost, chargedCost);

        objectRef.status = UploadStatus.Failed;
        objectRef.coordinator = msg.sender;
        objectRef.actualCost = chargedCost;
        objectRef.updatedAt = uint64(block.timestamp);
        _removeActiveObject(objectRef);

        AccountUsage storage usage = _usage[objectRef.accountId];
        _releasePendingBytes(usage, objectRef);
        usage.reservedCost -= objectRef.reservedCost;
        usage.totalActualCost += chargedCost;
        usage.totalFailedUploads += 1;

        emit UsageReleased(objectRef.accountId, objectId, objectRef.reservedCost - chargedCost);
        emit UploadFailed(objectId, objectRef.accountId, reasonHash, chargedCost);
    }

    function cancelUpload(uint256 objectId) external {
        StorageObject storage objectRef = _requireMutableObject(objectId);
        if (!_isAuthorizedCancelCaller(objectRef)) revert UnauthorizedCaller(msg.sender);

        objectRef.status = UploadStatus.Cancelled;
        objectRef.updatedAt = uint64(block.timestamp);
        _removeActiveObject(objectRef);
        AccountUsage storage usage = _usage[objectRef.accountId];
        _releasePendingBytes(usage, objectRef);
        usage.reservedCost -= objectRef.reservedCost;

        emit UsageReleased(objectRef.accountId, objectId, objectRef.reservedCost);
        emit UploadCancelled(objectId, objectRef.accountId);
    }

    function expireUpload(uint256 objectId) external {
        StorageObject storage objectRef = _requireMutableObject(objectId);
        if (block.timestamp <= objectRef.requestExpiresAt) revert RequestNotExpired(objectId);

        objectRef.status = UploadStatus.Expired;
        objectRef.updatedAt = uint64(block.timestamp);
        _removeActiveObject(objectRef);
        AccountUsage storage usage = _usage[objectRef.accountId];
        _releasePendingBytes(usage, objectRef);
        usage.reservedCost -= objectRef.reservedCost;

        emit UsageReleased(objectRef.accountId, objectId, objectRef.reservedCost);
        emit UploadExpired(objectId, objectRef.accountId);
    }

    function setCoordinator(address coordinator, CoordinatorPolicy calldata coordinatorPolicy)
        external
        onlyOwner
    {
        if (coordinator == address(0)) revert UnauthorizedCoordinator(coordinator);
        if (!_knownCoordinatorAddresses[coordinator]) {
            _knownCoordinatorAddresses[coordinator] = true;
            _coordinatorAddresses.push(coordinator);
        }
        coordinatorPolicies[coordinator] = coordinatorPolicy;
        emit CoordinatorUpdated(
            coordinator,
            coordinatorPolicy.allowed,
            coordinatorPolicy.maxFinalizeDelay,
            coordinatorPolicy.sessionKeyExpiresAt,
            coordinatorPolicy.permissionsHash
        );
    }

    function setPolicy(PolicyConfig calldata newPolicy) external onlyOwner {
        _validatePolicy(newPolicy);
        policy = newPolicy;
        emit PolicyUpdated(_policyHash(newPolicy));
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) revert UnauthorizedCaller(relayer);
        if (!_knownRelayerAddresses[relayer]) {
            _knownRelayerAddresses[relayer] = true;
            _relayerAddresses.push(relayer);
        }
        _relayers[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function recordDataset(DatasetRecord calldata dataset) external {
        _requireActiveCoordinator();
        if (dataset.accountId == bytes32(0)) revert InvalidAccount();
        DatasetRecord memory stored = dataset;
        if (stored.createdAt == 0) stored.createdAt = uint64(block.timestamp);
        stored.updatedAt = uint64(block.timestamp);
        if (!_knownDatasetKeys[stored.accountId][stored.providerId][stored.datasetId]) {
            _knownDatasetKeys[stored.accountId][stored.providerId][stored.datasetId] = true;
            _datasetKeys.push(
                DatasetKey({
                    accountId: stored.accountId,
                    providerId: stored.providerId,
                    datasetId: stored.datasetId
                })
            );
        }
        _datasets[stored.accountId][stored.providerId][stored.datasetId] = stored;
        emit DatasetRecorded(
            stored.accountId,
            stored.providerId,
            stored.datasetId,
            stored.payer,
            stored.storageClass,
            stored.withCDN
        );
    }

    function getStorageObject(uint256 objectId) external view returns (StorageObject memory) {
        return _objects[objectId];
    }

    function getAccountUsage(bytes32 accountId) external view returns (AccountUsage memory) {
        return _usage[accountId];
    }

    function objectCount() external view returns (uint256) {
        return nextObjectId - 1;
    }

    function accountCount() external view returns (uint256) {
        return _accountIds.length;
    }

    function coordinatorCount() external view returns (uint256) {
        return _coordinatorAddresses.length;
    }

    function relayerCount() external view returns (uint256) {
        return _relayerAddresses.length;
    }

    function datasetRecordCount() external view returns (uint256) {
        return _datasetKeys.length;
    }

    function listStorageObjectIds(uint256 cursorIdExclusive, uint256 limit, bool includeTerminal)
        external
        view
        returns (uint256[] memory ids)
    {
        _requireValidListLimit(limit);
        if (includeTerminal) {
            return _listAllStorageObjectIds(cursorIdExclusive, limit);
        }
        return _listActiveStorageObjectIds(cursorIdExclusive, limit);
    }

    function listAccountIds(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory accountIds)
    {
        _requireValidListLimit(limit);
        uint256 pageSize = _boundedOffsetSize(_accountIds.length, offset, limit);
        accountIds = new bytes32[](pageSize);
        for (uint256 i = 0; i < pageSize; i++) {
            accountIds[i] = _accountIds[offset + i];
        }
    }

    function listAccountObjectIds(
        bytes32 accountId,
        uint256 cursorIdExclusive,
        uint256 limit,
        bool includeTerminal
    ) external view returns (uint256[] memory ids) {
        _requireValidListLimit(limit);
        if (includeTerminal) {
            return _listAllAccountObjectIds(accountId, cursorIdExclusive, limit);
        }
        return _listActiveAccountObjectIds(accountId, cursorIdExclusive, limit);
    }

    function listCoordinatorAddresses(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory coordinators)
    {
        _requireValidListLimit(limit);
        uint256 pageSize = _boundedOffsetSize(_coordinatorAddresses.length, offset, limit);
        coordinators = new address[](pageSize);
        for (uint256 i = 0; i < pageSize; i++) {
            coordinators[i] = _coordinatorAddresses[offset + i];
        }
    }

    function listRelayerAddresses(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory relayers)
    {
        _requireValidListLimit(limit);
        uint256 pageSize = _boundedOffsetSize(_relayerAddresses.length, offset, limit);
        relayers = new address[](pageSize);
        for (uint256 i = 0; i < pageSize; i++) {
            relayers[i] = _relayerAddresses[offset + i];
        }
    }

    function listDatasetKeys(uint256 offset, uint256 limit)
        external
        view
        returns (DatasetKey[] memory keys)
    {
        _requireValidListLimit(limit);
        uint256 pageSize = _boundedOffsetSize(_datasetKeys.length, offset, limit);
        keys = new DatasetKey[](pageSize);
        for (uint256 i = 0; i < pageSize; i++) {
            keys[i] = _datasetKeys[offset + i];
        }
    }

    function readBatch(bytes[] calldata calls) external view returns (bytes[] memory results) {
        _requireValidListLimit(calls.length);
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory result) = address(this).staticcall(calls[i]);
            if (!ok) revert ReadBatchCallFailed(i, result);
            results[i] = result;
        }
    }

    function getCopyReceipts(uint256 objectId) external view returns (CopyReceipt[] memory) {
        return _copyReceipts[objectId];
    }

    function isRelayer(address relayer) external view returns (bool) {
        return _relayers[relayer];
    }

    function receiptPayer(uint256 objectId) external view returns (address payer) {
        return _receiptPayers[objectId];
    }

    function getDatasetRecord(bytes32 accountId, uint256 providerId, uint256 datasetId)
        external
        view
        returns (DatasetRecord memory)
    {
        return _datasets[accountId][providerId][datasetId];
    }

    function objectByIdempotencyKey(bytes32 accountId, bytes32 idempotencyKey)
        external
        view
        returns (uint256 objectId)
    {
        return _objectByIdempotencyKey[accountId][idempotencyKey];
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)
            )
        );
    }

    function requestUploadDigest(RequestUploadParams calldata params)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), _requestUploadStructHash(params))
        );
    }

    function _storeRequestedObject(
        uint256 objectId,
        RequestUploadParams calldata params,
        uint64 expiresAt
    ) private {
        StorageObject storage objectRef = _objects[objectId];
        objectRef.objectId = objectId;
        objectRef.accountId = params.accountId;
        objectRef.user = params.user;
        objectRef.idempotencyKey = params.idempotencyKey;
        objectRef.contentHash = params.contentHash;
        objectRef.metadataHash = params.metadataHash;
        objectRef.size = params.size;
        objectRef.requestedCopies = params.requestedCopies;
        objectRef.withCDN = params.withCDN;
        objectRef.maxCost = params.maxCost;
        objectRef.reservedCost = params.maxCost;
        objectRef.status = UploadStatus.Requested;
        objectRef.requestExpiresAt = expiresAt;
        objectRef.createdAt = uint64(block.timestamp);
        objectRef.updatedAt = uint64(block.timestamp);
    }

    function _indexRequestedObject(uint256 objectId, bytes32 accountId) private {
        if (!_knownAccountIds[accountId]) {
            _knownAccountIds[accountId] = true;
            _accountIds.push(accountId);
        }

        _accountObjectNext[objectId] = _accountObjectHeads[accountId];
        _accountObjectHeads[accountId] = objectId;

        _activeObjectIndexed[objectId] = true;
        _activeObjectNext[objectId] = _activeObjectHead;
        if (_activeObjectHead != 0) {
            _activeObjectPrev[_activeObjectHead] = objectId;
        }
        _activeObjectHead = objectId;
        _activeObjectCount += 1;

        uint256 accountActiveHead = _accountActiveObjectHeads[accountId];
        _accountActiveObjectNext[objectId] = accountActiveHead;
        if (accountActiveHead != 0) {
            _accountActiveObjectPrev[accountActiveHead] = objectId;
        }
        _accountActiveObjectHeads[accountId] = objectId;
    }

    function _removeActiveObject(StorageObject storage objectRef) private {
        uint256 objectId = objectRef.objectId;
        if (!_activeObjectIndexed[objectId]) return;

        uint256 previousObjectId = _activeObjectPrev[objectId];
        uint256 nextObjectId_ = _activeObjectNext[objectId];
        if (previousObjectId == 0) {
            _activeObjectHead = nextObjectId_;
        } else {
            _activeObjectNext[previousObjectId] = nextObjectId_;
        }
        if (nextObjectId_ != 0) {
            _activeObjectPrev[nextObjectId_] = previousObjectId;
        }
        delete _activeObjectIndexed[objectId];
        delete _activeObjectPrev[objectId];
        // Keep the removed node's next pointer so stale page cursors can continue.
        _activeObjectCount -= 1;

        uint256 previousAccountObjectId = _accountActiveObjectPrev[objectId];
        uint256 nextAccountObjectId = _accountActiveObjectNext[objectId];
        if (previousAccountObjectId == 0) {
            _accountActiveObjectHeads[objectRef.accountId] = nextAccountObjectId;
        } else {
            _accountActiveObjectNext[previousAccountObjectId] = nextAccountObjectId;
        }
        if (nextAccountObjectId != 0) {
            _accountActiveObjectPrev[nextAccountObjectId] = previousAccountObjectId;
        }
        delete _accountActiveObjectPrev[objectId];
        // Keep the removed node's account next pointer for stale account cursors.
    }

    function _listAllStorageObjectIds(uint256 cursorIdExclusive, uint256 limit)
        private
        view
        returns (uint256[] memory ids)
    {
        if (limit == 0) return new uint256[](0);
        uint256 currentObjectId = _startObjectIdBelow(cursorIdExclusive);
        uint256[] memory page = new uint256[](limit);
        uint256 count;
        while (currentObjectId != 0 && count < limit) {
            page[count] = currentObjectId;
            count += 1;
            currentObjectId -= 1;
        }
        return _trimUintPage(page, count);
    }

    function _listActiveStorageObjectIds(uint256 cursorIdExclusive, uint256 limit)
        private
        view
        returns (uint256[] memory ids)
    {
        if (limit == 0 || _activeObjectCount == 0) return new uint256[](0);
        uint256 currentObjectId =
            cursorIdExclusive == 0 ? _activeObjectHead : _activeObjectNext[cursorIdExclusive];
        uint256[] memory page = new uint256[](_min(_activeObjectCount, limit));
        uint256 maxSteps = _activeTraversalStepLimit(limit);
        uint256 steps;
        uint256 count;
        while (currentObjectId != 0 && count < page.length) {
            if (steps == maxSteps) {
                revert ActiveCursorTraversalLimitExceeded(cursorIdExclusive, maxSteps);
            }
            steps += 1;
            if (_activeObjectIndexed[currentObjectId]) {
                page[count] = currentObjectId;
                count += 1;
            }
            currentObjectId = _activeObjectNext[currentObjectId];
        }
        return _trimUintPage(page, count);
    }

    function _listAllAccountObjectIds(bytes32 accountId, uint256 cursorIdExclusive, uint256 limit)
        private
        view
        returns (uint256[] memory ids)
    {
        if (limit == 0) return new uint256[](0);
        uint256 currentObjectId = _accountObjectHeads[accountId];
        if (cursorIdExclusive != 0) {
            if (_objects[cursorIdExclusive].accountId != accountId) return new uint256[](0);
            currentObjectId = _accountObjectNext[cursorIdExclusive];
        }

        uint256[] memory page = new uint256[](limit);
        uint256 count;
        while (currentObjectId != 0 && count < limit) {
            page[count] = currentObjectId;
            count += 1;
            currentObjectId = _accountObjectNext[currentObjectId];
        }
        return _trimUintPage(page, count);
    }

    function _listActiveAccountObjectIds(
        bytes32 accountId,
        uint256 cursorIdExclusive,
        uint256 limit
    ) private view returns (uint256[] memory ids) {
        if (limit == 0) return new uint256[](0);
        uint256 currentObjectId = _accountActiveObjectHeads[accountId];
        if (cursorIdExclusive != 0) {
            if (_objects[cursorIdExclusive].accountId != accountId) return new uint256[](0);
            currentObjectId = _accountActiveObjectNext[cursorIdExclusive];
        }

        uint256[] memory page = new uint256[](limit);
        uint256 maxSteps = _activeTraversalStepLimit(limit);
        uint256 steps;
        uint256 count;
        while (currentObjectId != 0 && count < limit) {
            if (steps == maxSteps) {
                revert ActiveCursorTraversalLimitExceeded(cursorIdExclusive, maxSteps);
            }
            steps += 1;
            if (_activeObjectIndexed[currentObjectId]) {
                page[count] = currentObjectId;
                count += 1;
            }
            currentObjectId = _accountActiveObjectNext[currentObjectId];
        }
        return _trimUintPage(page, count);
    }

    function _startObjectIdBelow(uint256 cursorIdExclusive) private view returns (uint256) {
        uint256 newestObjectId = nextObjectId - 1;
        if (cursorIdExclusive == 0 || cursorIdExclusive > newestObjectId) return newestObjectId;
        return cursorIdExclusive - 1;
    }

    function _requireValidListLimit(uint256 limit) private pure {
        if (limit > MAX_LIST_LIMIT) revert ListLimitExceeded(limit, MAX_LIST_LIMIT);
    }

    function _boundedOffsetSize(uint256 length, uint256 offset, uint256 limit)
        private
        pure
        returns (uint256)
    {
        if (limit == 0 || offset >= length) return 0;
        uint256 remaining = length - offset;
        return _min(remaining, limit);
    }

    function _activeTraversalStepLimit(uint256 limit) private pure returns (uint256) {
        return limit * 4;
    }

    function _trimUintPage(uint256[] memory page, uint256 count)
        private
        pure
        returns (uint256[] memory ids)
    {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = page[i];
        }
    }

    function _min(uint256 left, uint256 right) private pure returns (uint256) {
        return left < right ? left : right;
    }

    function _emitUploadRequested(
        uint256 objectId,
        uint64 expiresAt,
        RequestUploadParams calldata params
    ) private {
        emit UploadRequested(
            objectId,
            params.accountId,
            params.user,
            params.idempotencyKey,
            params.contentHash,
            params.metadataHash,
            params.size,
            params.requestedCopies,
            params.withCDN,
            params.maxCost,
            expiresAt
        );
    }

    function _validateRequestPolicy(RequestUploadParams calldata params) private view {
        if (params.accountId == bytes32(0) || params.idempotencyKey == bytes32(0)) {
            revert InvalidAccount();
        }
        if (params.size == 0 || params.size > policy.maxObjectSize) revert InvalidPolicy();
        if (params.requestedCopies == 0 || params.requestedCopies > policy.maxCopies) {
            revert InvalidPolicy();
        }
        if (params.maxCost > policy.maxCostPerUpload) revert InvalidPolicy();
    }

    function _validatePolicy(PolicyConfig calldata newPolicy) private pure {
        if (
            newPolicy.maxObjectSize == 0 || newPolicy.maxCopies == 0
                || newPolicy.defaultRequestTtl == 0
        ) revert InvalidPolicy();
    }

    function _authorizeRequest(RequestUploadParams calldata params, bytes calldata userSignature)
        private
        view
    {
        if (userSignature.length == 0) {
            if (params.user != address(0) && msg.sender == params.user) return;
            if (_relayers[msg.sender]) return;
            if (params.user == address(0)) revert InvalidUser();
            revert UnauthorizedCaller(msg.sender);
        }

        if (params.user == address(0)) revert InvalidUser();
        address recovered = _recoverSigner(requestUploadDigest(params), userSignature);
        if (recovered != params.user) revert InvalidSignature();
    }

    function _requestUploadStructHash(RequestUploadParams calldata params)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                REQUEST_UPLOAD_TYPEHASH,
                params.accountId,
                params.user,
                params.idempotencyKey,
                params.contentHash,
                params.metadataHash,
                params.size,
                params.requestedCopies,
                params.withCDN,
                params.maxCost,
                params.requestExpiresAt,
                address(this),
                block.chainid
            )
        );
    }

    function _recoverSigner(bytes32 digest, bytes calldata signature)
        private
        pure
        returns (address)
    {
        if (signature.length != 65) revert InvalidSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) > SECP256K1N_HALF_ORDER) revert InvalidSignature();

        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }

    function _validateReceipt(StorageObject storage objectRef, UploadReceipt calldata receipt)
        private
        view
    {
        if (receipt.payer == address(0)) revert InvalidPayer();
        if (receipt.receiptHash == bytes32(0)) revert ZeroReceiptHash();
        if (receipt.size != objectRef.size) {
            revert ReceiptSizeMismatch(receipt.size, objectRef.size);
        }
        if (receipt.requestedCopies != objectRef.requestedCopies) {
            revert RequestedCopyCountMismatch(receipt.requestedCopies, objectRef.requestedCopies);
        }
        if (receipt.completedCopies != receipt.copies.length) {
            revert CopyCountMismatch(receipt.completedCopies, receipt.copies.length);
        }
        if (receipt.actualCost > objectRef.maxCost) {
            revert CostExceedsMaximum(receipt.actualCost, objectRef.maxCost);
        }
        if (receipt.finalizationStatus == UploadFinalizationStatus.Failed) {
            _validateFailureCharge(objectRef.reservedCost, receipt.actualCost);
        }
    }

    function _validateFailureCharge(uint256 reservedCost, uint256 chargedCost) private view {
        if (chargedCost > reservedCost) revert CostExceedsMaximum(chargedCost, reservedCost);
        if (!policy.allowFailureCharges && chargedCost != 0) {
            revert CostExceedsMaximum(chargedCost, 0);
        }
    }

    function _statusFromReceipt(StorageObject storage objectRef, UploadReceipt calldata receipt)
        private
        view
        returns (UploadStatus)
    {
        if (receipt.finalizationStatus == UploadFinalizationStatus.Committed) {
            if (receipt.completedCopies != objectRef.requestedCopies) {
                revert CopyCountMismatch(receipt.completedCopies, objectRef.requestedCopies);
            }
            return UploadStatus.Committed;
        }
        if (receipt.finalizationStatus == UploadFinalizationStatus.Partial) {
            if (
                receipt.completedCopies == 0 || receipt.completedCopies >= objectRef.requestedCopies
            ) {
                revert CopyCountMismatch(receipt.completedCopies, receipt.copies.length);
            }
            return UploadStatus.Partial;
        }
        if (receipt.completedCopies != 0) {
            revert CopyCountMismatch(receipt.completedCopies, 0);
        }
        return UploadStatus.Failed;
    }

    function _releasePendingBytes(AccountUsage storage usage, StorageObject storage objectRef)
        private
    {
        usage.pendingBytes -= _requestedBytes(objectRef.size, objectRef.requestedCopies);
    }

    function _requireMutableObject(uint256 objectId) private view returns (StorageObject storage) {
        StorageObject storage objectRef = _objects[objectId];
        if (objectRef.status == UploadStatus.None) {
            revert InvalidUploadStatus(objectId, UploadStatus.Requested, UploadStatus.None);
        }
        if (_isTerminal(objectRef.status)) revert TerminalUploadStatus(objectId, objectRef.status);
        return objectRef;
    }

    function _requireActiveCoordinator() private view {
        CoordinatorPolicy memory coordinatorPolicy = coordinatorPolicies[msg.sender];
        bool expired = coordinatorPolicy.sessionKeyExpiresAt != 0
            && block.timestamp > coordinatorPolicy.sessionKeyExpiresAt;
        if (!coordinatorPolicy.allowed || expired) revert UnauthorizedCoordinator(msg.sender);
    }

    function _requireNotExpired(StorageObject storage objectRef) private view {
        if (block.timestamp > objectRef.requestExpiresAt) revert RequestExpired(objectRef.objectId);
    }

    function _isAuthorizedCancelCaller(StorageObject storage objectRef)
        private
        view
        returns (bool)
    {
        return msg.sender == owner || _relayers[msg.sender]
            || (objectRef.user != address(0) && msg.sender == objectRef.user);
    }

    function _isTerminal(UploadStatus status) private pure returns (bool) {
        return status == UploadStatus.Committed || status == UploadStatus.Partial
            || status == UploadStatus.Failed || status == UploadStatus.Cancelled
            || status == UploadStatus.Expired || status == UploadStatus.Deleted;
    }

    function _requestedBytes(uint64 size, uint8 requestedCopies) private pure returns (uint256) {
        return uint256(size) * requestedCopies;
    }

    function _policyHash(PolicyConfig memory config) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                config.paused,
                config.maxObjectSize,
                config.maxCopies,
                config.maxCostPerUpload,
                config.maxActiveBytesPerAccount,
                config.defaultRequestTtl,
                config.allowFailureCharges
            )
        );
    }
}
