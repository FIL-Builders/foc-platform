// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { FocPlatformRegistry } from "../../contracts/FocPlatformRegistry.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function expectRevert(bytes calldata revertData) external;
    function expectEmit(
        bool checkTopic1,
        bool checkTopic2,
        bool checkTopic3,
        bool checkData,
        address emitter
    ) external;
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
}

contract FocPlatformRegistryTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private constant ACCOUNT_ID = keccak256("platform-account");
    bytes32 private constant IDEMPOTENCY_KEY = keccak256("upload-key");
    bytes32 private constant CONTENT_HASH = keccak256("content");
    bytes32 private constant METADATA_HASH = keccak256("metadata");
    bytes32 private constant PIECE_CID_HASH = keccak256("piece-cid");
    bytes32 private constant RECEIPT_HASH = keccak256("receipt");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant REQUEST_UPLOAD_TYPEHASH = keccak256(
        "RequestUpload(bytes32 accountId,address user,bytes32 idempotencyKey,bytes32 contentHash,bytes32 metadataHash,uint64 size,uint8 requestedCopies,bool withCDN,uint256 maxCost,uint64 requestExpiresAt,address registry,uint256 chainId)"
    );

    address private constant RELAYER = address(0x1001);
    address private constant COORDINATOR = address(0x2002);
    address private constant ATTACKER = address(0x3003);
    address private constant PAYER = address(0x4004);

    FocPlatformRegistry private registry;

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
    event UsageReserved(
        bytes32 indexed accountId,
        uint256 indexed objectId,
        uint256 reservedCost,
        uint256 activeBytesBefore
    );
    event UsageReleased(bytes32 indexed accountId, uint256 indexed objectId, uint256 releasedCost);
    event UsageFinalized(
        bytes32 indexed accountId,
        uint256 indexed objectId,
        uint256 actualCost,
        uint256 activeBytesDelta
    );
    event ReceiptPayerRecorded(
        uint256 indexed objectId, bytes32 indexed accountId, address indexed payer
    );
    event UploadFinalized(
        uint256 indexed objectId,
        bytes32 indexed accountId,
        FocPlatformRegistry.UploadFinalizationStatus finalizationStatus,
        bytes32 pieceCidHash,
        uint8 completedCopies,
        uint256 actualCost,
        bytes32 receiptHash
    );

    function setUp() public {
        registry = new FocPlatformRegistry();
        registry.setRelayer(RELAYER, true);
        registry.setCoordinator(
            COORDINATOR,
            FocPlatformRegistry.CoordinatorPolicy({
                allowed: true,
                maxFinalizeDelay: 1 hours,
                sessionKeyExpiresAt: uint64(block.timestamp + 30 days),
                permissionsHash: keccak256("session-permissions")
            })
        );
    }

    function testRelayerRequestReservesUsageAndRejectsDuplicate() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));

        vm.expectEmit(true, true, false, true, address(registry));
        emit UsageReserved(ACCOUNT_ID, 1, params.maxCost, 0);
        vm.expectEmit(true, true, true, true, address(registry));
        emit UploadRequested(
            1,
            ACCOUNT_ID,
            address(0),
            IDEMPOTENCY_KEY,
            CONTENT_HASH,
            METADATA_HASH,
            params.size,
            params.requestedCopies,
            params.withCDN,
            params.maxCost,
            params.requestExpiresAt
        );

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(objectRef.objectId == objectId, "object id not stored");
        require(objectRef.accountId == ACCOUNT_ID, "account not stored");
        require(objectRef.status == FocPlatformRegistry.UploadStatus.Requested, "unexpected status");
        require(
            registry.objectByIdempotencyKey(ACCOUNT_ID, IDEMPOTENCY_KEY) == objectId,
            "idempotency lookup missing"
        );

        FocPlatformRegistry.AccountUsage memory usage = registry.getAccountUsage(ACCOUNT_ID);
        require(usage.reservedCost == params.maxCost, "reserved cost mismatch");
        require(
            usage.pendingBytes == uint256(params.size) * params.requestedCopies,
            "pending bytes mismatch"
        );
        require(usage.totalRequestedUploads == 1, "request counter mismatch");

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FocPlatformRegistry.DuplicateIdempotencyKey.selector,
                ACCOUNT_ID,
                IDEMPOTENCY_KEY,
                objectId
            )
        );
        registry.requestUpload(params, "");
    }

    function testCoordinatorFinalizesCommittedUploadAndRecordsCopies() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        vm.prank(COORDINATOR);
        registry.startUpload(objectId);

        vm.prank(COORDINATOR);
        registry.finalizeUpload(objectId, _receipt(params, 2, 7 ether));

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(
            objectRef.status == FocPlatformRegistry.UploadStatus.Committed, "upload not committed"
        );
        require(objectRef.coordinator == COORDINATOR, "coordinator not stored");
        require(objectRef.pieceCidHash == PIECE_CID_HASH, "piece hash not stored");
        require(objectRef.completedCopies == 2, "copy count not stored");
        require(objectRef.actualCost == 7 ether, "actual cost not stored");
        require(objectRef.receiptHash == RECEIPT_HASH, "receipt hash not stored");
        require(registry.receiptPayer(objectId) == PAYER, "receipt payer not stored");

        FocPlatformRegistry.AccountUsage memory usage = registry.getAccountUsage(ACCOUNT_ID);
        require(usage.reservedCost == 0, "reservation not released");
        require(usage.pendingBytes == 0, "pending bytes not released");
        require(usage.activeBytes == uint256(params.size) * 2, "active bytes mismatch");
        require(usage.activeObjects == 1, "active object mismatch");
        require(usage.totalActualCost == 7 ether, "actual cost counter mismatch");
        require(usage.totalUploadedBytes == uint256(params.size) * 2, "uploaded bytes mismatch");
        require(usage.totalFinalizedUploads == 1, "finalized counter mismatch");

        FocPlatformRegistry.CopyReceipt[] memory copies = registry.getCopyReceipts(objectId);
        require(copies.length == 2, "copy receipts missing");
        require(copies[0].providerId == 111, "provider not stored");
        require(copies[1].datasetId == 222, "dataset not stored");

        vm.expectRevert(
            abi.encodeWithSelector(
                FocPlatformRegistry.TerminalUploadStatus.selector,
                objectId,
                FocPlatformRegistry.UploadStatus.Committed
            )
        );
        registry.cancelUpload(objectId);
    }

    function testPartialFinalizationAccountsCompletedCopies() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        FocPlatformRegistry.UploadReceipt memory receipt = _receipt(params, 1, 3 ether);
        receipt.finalizationStatus = FocPlatformRegistry.UploadFinalizationStatus.Partial;

        vm.prank(COORDINATOR);
        registry.finalizeUpload(objectId, receipt);

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(objectRef.status == FocPlatformRegistry.UploadStatus.Partial, "not partial");
        require(objectRef.completedCopies == 1, "partial copy count mismatch");

        FocPlatformRegistry.AccountUsage memory usage = registry.getAccountUsage(ACCOUNT_ID);
        require(usage.reservedCost == 0, "reservation not released");
        require(usage.pendingBytes == 0, "pending bytes not released");
        require(usage.activeBytes == params.size, "partial active bytes mismatch");
        require(usage.activeObjects == 1, "partial object mismatch");
        require(usage.totalActualCost == 3 ether, "partial actual cost mismatch");
        require(usage.totalUploadedBytes == params.size, "partial uploaded bytes mismatch");
        require(usage.totalFinalizedUploads == 1, "partial finalized counter mismatch");
    }

    function testFinalizeRejectsExpiredRequest() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));
        params.requestExpiresAt = uint64(block.timestamp + 1 hours);

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        vm.warp(params.requestExpiresAt + 1);

        vm.prank(COORDINATOR);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.RequestExpired.selector, objectId)
        );
        registry.finalizeUpload(objectId, _receipt(params, 2, 7 ether));
    }

    function testFinalizeRejectsInvalidReceiptFields() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        FocPlatformRegistry.UploadReceipt memory receipt = _receipt(params, 2, 7 ether);
        receipt.receiptHash = bytes32(0);

        vm.prank(COORDINATOR);
        vm.expectRevert(abi.encodeWithSelector(FocPlatformRegistry.ZeroReceiptHash.selector));
        registry.finalizeUpload(objectId, receipt);

        receipt = _receipt(params, 2, 7 ether);
        receipt.payer = address(0);

        vm.prank(COORDINATOR);
        vm.expectRevert(abi.encodeWithSelector(FocPlatformRegistry.InvalidPayer.selector));
        registry.finalizeUpload(objectId, receipt);

        receipt = _receipt(params, 2, 7 ether);
        receipt.size = params.size + 1;

        vm.prank(COORDINATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                FocPlatformRegistry.ReceiptSizeMismatch.selector, receipt.size, params.size
            )
        );
        registry.finalizeUpload(objectId, receipt);

        receipt = _receipt(params, 2, params.maxCost + 1);

        vm.prank(COORDINATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                FocPlatformRegistry.CostExceedsMaximum.selector, receipt.actualCost, params.maxCost
            )
        );
        registry.finalizeUpload(objectId, receipt);

        receipt = _receipt(params, 2, 7 ether);
        receipt.requestedCopies = 1;

        vm.prank(COORDINATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                FocPlatformRegistry.RequestedCopyCountMismatch.selector,
                receipt.requestedCopies,
                params.requestedCopies
            )
        );
        registry.finalizeUpload(objectId, receipt);

        receipt = _receipt(params, 2, 7 ether);
        receipt.completedCopies = 1;

        vm.prank(COORDINATOR);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.CopyCountMismatch.selector, 1, 2)
        );
        registry.finalizeUpload(objectId, receipt);
    }

    function testRequestRejectsPendingByteCapOverflow() public {
        FocPlatformRegistry.PolicyConfig memory cappedPolicy = _policy(false);
        cappedPolicy.maxActiveBytesPerAccount = 1024;
        registry.setPolicy(cappedPolicy);

        FocPlatformRegistry.RequestUploadParams memory first = _defaultParams(address(0));
        first.requestedCopies = 1;

        FocPlatformRegistry.RequestUploadParams memory second = _defaultParams(address(0));
        second.idempotencyKey = keccak256("second-upload-key");
        second.requestedCopies = 1;

        vm.prank(RELAYER);
        uint256 firstObjectId = registry.requestUpload(first, "");

        FocPlatformRegistry.AccountUsage memory usage = registry.getAccountUsage(ACCOUNT_ID);
        require(usage.pendingBytes == 1024, "first request not pending");

        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(FocPlatformRegistry.InvalidPolicy.selector));
        registry.requestUpload(second, "");

        vm.prank(COORDINATOR);
        registry.finalizeUpload(firstObjectId, _receipt(first, 1, 1 ether));

        usage = registry.getAccountUsage(ACCOUNT_ID);
        require(usage.activeBytes == 1024, "active bytes mismatch");
        require(usage.pendingBytes == 0, "pending bytes not released");
    }

    function testCoordinatorFinalizesFailureWithoutActiveUsage() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        FocPlatformRegistry.UploadReceipt memory receipt = _receipt(params, 0, 0);
        receipt.finalizationStatus = FocPlatformRegistry.UploadFinalizationStatus.Failed;

        vm.expectEmit(true, true, false, true, address(registry));
        emit UsageReleased(ACCOUNT_ID, objectId, params.maxCost);
        vm.expectEmit(true, true, false, true, address(registry));
        emit UsageFinalized(ACCOUNT_ID, objectId, 0, 0);
        vm.expectEmit(true, true, true, true, address(registry));
        emit ReceiptPayerRecorded(objectId, ACCOUNT_ID, PAYER);
        vm.expectEmit(true, true, false, true, address(registry));
        emit UploadFinalized(
            objectId,
            ACCOUNT_ID,
            FocPlatformRegistry.UploadFinalizationStatus.Failed,
            PIECE_CID_HASH,
            0,
            0,
            RECEIPT_HASH
        );

        vm.prank(COORDINATOR);
        registry.finalizeUpload(objectId, receipt);

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(objectRef.status == FocPlatformRegistry.UploadStatus.Failed, "not failed");

        FocPlatformRegistry.AccountUsage memory usage = registry.getAccountUsage(ACCOUNT_ID);
        require(usage.reservedCost == 0, "reservation not released");
        require(usage.pendingBytes == 0, "pending bytes not released");
        require(usage.activeBytes == 0, "failed upload counted active bytes");
        require(usage.totalFailedUploads == 1, "failed counter mismatch");
        require(usage.totalActualCost == 0, "failed actual cost mismatch");
    }

    function testCoordinatorCanRecordFailureChargesWhenPolicyAllows() public {
        FocPlatformRegistry.PolicyConfig memory chargePolicy = _policy(false);
        chargePolicy.allowFailureCharges = true;
        registry.setPolicy(chargePolicy);

        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        vm.prank(COORDINATOR);
        registry.failUpload(objectId, keccak256("provider-accepted-work"), 2 ether);

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(objectRef.status == FocPlatformRegistry.UploadStatus.Failed, "not failed");
        require(objectRef.actualCost == 2 ether, "failure charge not stored");

        FocPlatformRegistry.AccountUsage memory usage = registry.getAccountUsage(ACCOUNT_ID);
        require(usage.reservedCost == 0, "reservation not released");
        require(usage.pendingBytes == 0, "pending bytes not released");
        require(usage.totalActualCost == 2 ether, "failure cost counter mismatch");
        require(usage.totalFailedUploads == 1, "failed counter mismatch");
    }

    function testCoordinatorCannotFailExpiredRequestEvenWhenFailureChargesAllowed() public {
        FocPlatformRegistry.PolicyConfig memory chargePolicy = _policy(false);
        chargePolicy.allowFailureCharges = true;
        registry.setPolicy(chargePolicy);

        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));
        params.requestExpiresAt = uint64(block.timestamp + 1 hours);

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        vm.warp(params.requestExpiresAt + 1);

        vm.prank(COORDINATOR);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.RequestExpired.selector, objectId)
        );
        registry.failUpload(objectId, keccak256("provider-accepted-work"), 2 ether);
    }

    function testUnauthorizedCoordinatorCannotStart() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.UnauthorizedCoordinator.selector, ATTACKER)
        );
        registry.startUpload(objectId);
    }

    function testCoordinatorExpiryAndInvalidStartTransitionRevert() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        vm.prank(COORDINATOR);
        registry.startUpload(objectId);

        vm.prank(COORDINATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                FocPlatformRegistry.InvalidUploadStatus.selector,
                objectId,
                FocPlatformRegistry.UploadStatus.Requested,
                FocPlatformRegistry.UploadStatus.Uploading
            )
        );
        registry.startUpload(objectId);

        registry.setCoordinator(
            COORDINATOR,
            FocPlatformRegistry.CoordinatorPolicy({
                allowed: true,
                maxFinalizeDelay: 1 hours,
                sessionKeyExpiresAt: uint64(block.timestamp + 1),
                permissionsHash: keccak256("session-permissions")
            })
        );

        vm.warp(block.timestamp + 2);
        vm.prank(COORDINATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                FocPlatformRegistry.UnauthorizedCoordinator.selector, COORDINATOR
            )
        );
        registry.failUpload(objectId, keccak256("too-late"), 0);
    }

    function testCoordinatorFailureReleasesReservationAndBlocksFailureChargesByDefault() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        vm.prank(COORDINATOR);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.CostExceedsMaximum.selector, 1 ether, 0)
        );
        registry.failUpload(objectId, keccak256("provider-failed"), 1 ether);

        vm.prank(COORDINATOR);
        registry.failUpload(objectId, keccak256("provider-failed"), 0);

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(objectRef.status == FocPlatformRegistry.UploadStatus.Failed, "not failed");

        FocPlatformRegistry.AccountUsage memory usage = registry.getAccountUsage(ACCOUNT_ID);
        require(usage.reservedCost == 0, "reservation not released");
        require(usage.pendingBytes == 0, "pending bytes not released");
        require(usage.totalFailedUploads == 1, "failed counter mismatch");
        require(usage.activeBytes == 0, "failed upload counted active bytes");

        vm.expectRevert(
            abi.encodeWithSelector(
                FocPlatformRegistry.TerminalUploadStatus.selector,
                objectId,
                FocPlatformRegistry.UploadStatus.Failed
            )
        );
        registry.expireUpload(objectId);
    }

    function testExpireUploadAfterDeadlineReleasesReservation() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));
        params.requestExpiresAt = uint64(block.timestamp + 1 hours);

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.RequestNotExpired.selector, objectId)
        );
        registry.expireUpload(objectId);

        vm.warp(params.requestExpiresAt + 1);
        registry.expireUpload(objectId);

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(objectRef.status == FocPlatformRegistry.UploadStatus.Expired, "not expired");

        FocPlatformRegistry.AccountUsage memory usage = registry.getAccountUsage(ACCOUNT_ID);
        require(usage.reservedCost == 0, "reservation not released");
        require(usage.pendingBytes == 0, "pending bytes not released");
        require(usage.activeBytes == 0, "expired upload counted active bytes");
    }

    function testUploadingUploadCanExpireAfterDeadline() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));
        params.requestExpiresAt = uint64(block.timestamp + 1 hours);

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        vm.prank(COORDINATOR);
        registry.startUpload(objectId);

        vm.warp(params.requestExpiresAt + 1);
        registry.expireUpload(objectId);

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(
            objectRef.status == FocPlatformRegistry.UploadStatus.Expired, "uploading not expired"
        );
    }

    function testSignatureRelayedUpload() public {
        uint256 userPrivateKey = 0xA11CE;
        address user = vm.addr(userPrivateKey);
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(user);

        bytes32 digest = registry.requestUploadDigest(params);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(ATTACKER);
        uint256 objectId = registry.requestUpload(params, signature);

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(objectRef.user == user, "signed user not stored");
        require(objectRef.status == FocPlatformRegistry.UploadStatus.Requested, "not requested");
    }

    function testRequestUploadDigestUsesEip712Domain() public view {
        address user = address(0xA11CE);
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(user);

        bytes32 expectedDomain = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("FocPlatformRegistry"),
                keccak256("1"),
                block.chainid,
                address(registry)
            )
        );
        bytes32 expectedDigest = keccak256(
            abi.encodePacked("\x19\x01", expectedDomain, _requestUploadStructHash(params))
        );

        require(registry.domainSeparator() == expectedDomain, "domain separator mismatch");
        require(registry.requestUploadDigest(params) == expectedDigest, "eip712 digest mismatch");
    }

    function testInvalidSignatureAndUnauthorizedDirectRequestRevert() public {
        uint256 userPrivateKey = 0xA11CE;
        uint256 attackerPrivateKey = 0xBAD;
        address user = vm.addr(userPrivateKey);
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(user);

        bytes32 digest = registry.requestUploadDigest(params);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.expectRevert(abi.encodeWithSelector(FocPlatformRegistry.InvalidSignature.selector));
        registry.requestUpload(params, signature);

        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.UnauthorizedCaller.selector, ATTACKER)
        );
        registry.requestUpload(params, "");
    }

    function testCancelByUserReleasesReservation() public {
        address user = address(0x5151);
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(user);

        vm.prank(user);
        uint256 objectId = registry.requestUpload(params, "");

        vm.prank(user);
        registry.cancelUpload(objectId);

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(objectRef.status == FocPlatformRegistry.UploadStatus.Cancelled, "not cancelled");

        FocPlatformRegistry.AccountUsage memory usage = registry.getAccountUsage(ACCOUNT_ID);
        require(usage.reservedCost == 0, "reservation not released");
        require(usage.pendingBytes == 0, "pending bytes not released");
    }

    function testCancelByUnauthorizedCallerReverts() public {
        address user = address(0x5151);
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(user);

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.UnauthorizedCaller.selector, ATTACKER)
        );
        registry.cancelUpload(objectId);
    }

    function testAdminOnlyPolicyRelayerCoordinatorAndPausedRequests() public {
        FocPlatformRegistry.PolicyConfig memory pausedPolicy = _policy(true);

        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.UnauthorizedCaller.selector, ATTACKER)
        );
        registry.setPolicy(pausedPolicy);

        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.UnauthorizedCaller.selector, ATTACKER)
        );
        registry.setRelayer(address(0x9999), true);

        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.UnauthorizedCaller.selector, ATTACKER)
        );
        registry.setCoordinator(
            address(0x8888),
            FocPlatformRegistry.CoordinatorPolicy({
                allowed: true,
                maxFinalizeDelay: 1 hours,
                sessionKeyExpiresAt: uint64(block.timestamp + 30 days),
                permissionsHash: keccak256("extra-coordinator")
            })
        );

        registry.setPolicy(pausedPolicy);

        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(FocPlatformRegistry.Paused.selector));
        registry.requestUpload(_defaultParams(address(0)), "");

        FocPlatformRegistry.PolicyConfig memory invalidPolicy = _policy(false);
        invalidPolicy.maxCopies = 0;

        vm.expectRevert(abi.encodeWithSelector(FocPlatformRegistry.InvalidPolicy.selector));
        registry.setPolicy(invalidPolicy);
    }

    function testRequestPolicyRejectsInvalidAndExpiredRequests() public {
        FocPlatformRegistry.RequestUploadParams memory params = _defaultParams(address(0));
        params.accountId = bytes32(0);

        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(FocPlatformRegistry.InvalidAccount.selector));
        registry.requestUpload(params, "");

        params = _defaultParams(address(0));
        params.requestExpiresAt = uint64(block.timestamp);

        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(FocPlatformRegistry.RequestExpired.selector, 0));
        registry.requestUpload(params, "");

        params = _defaultParams(address(0));
        params.requestExpiresAt = 0;

        vm.prank(RELAYER);
        uint256 objectId = registry.requestUpload(params, "");

        FocPlatformRegistry.StorageObject memory objectRef = registry.getStorageObject(objectId);
        require(objectRef.requestExpiresAt == block.timestamp + 1 days, "default ttl mismatch");
    }

    function testDatasetRecordingIsCoordinatorOnlyAndReadable() public {
        FocPlatformRegistry.DatasetRecord memory dataset = FocPlatformRegistry.DatasetRecord({
            accountId: ACCOUNT_ID,
            payer: PAYER,
            providerId: 404,
            datasetId: 505,
            storageClass: keccak256("warm"),
            withCDN: true,
            createdAt: 0,
            updatedAt: 0
        });

        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(FocPlatformRegistry.UnauthorizedCoordinator.selector, ATTACKER)
        );
        registry.recordDataset(dataset);

        vm.prank(COORDINATOR);
        registry.recordDataset(dataset);

        FocPlatformRegistry.DatasetRecord memory stored =
            registry.getDatasetRecord(ACCOUNT_ID, 404, 505);
        require(stored.accountId == ACCOUNT_ID, "dataset account mismatch");
        require(stored.payer == PAYER, "dataset payer mismatch");
        require(stored.providerId == 404, "dataset provider mismatch");
        require(stored.datasetId == 505, "dataset id mismatch");
        require(stored.storageClass == keccak256("warm"), "dataset class mismatch");
        require(stored.withCDN, "dataset cdn mismatch");
        require(stored.createdAt == block.timestamp, "dataset createdAt mismatch");
        require(stored.updatedAt == block.timestamp, "dataset updatedAt mismatch");
    }

    function _defaultParams(address user)
        private
        view
        returns (FocPlatformRegistry.RequestUploadParams memory)
    {
        return FocPlatformRegistry.RequestUploadParams({
            accountId: ACCOUNT_ID,
            user: user,
            idempotencyKey: IDEMPOTENCY_KEY,
            contentHash: CONTENT_HASH,
            metadataHash: METADATA_HASH,
            size: 1024,
            requestedCopies: 2,
            withCDN: true,
            maxCost: 10 ether,
            requestExpiresAt: uint64(block.timestamp + 1 days)
        });
    }

    function _policy(bool paused) private pure returns (FocPlatformRegistry.PolicyConfig memory) {
        return FocPlatformRegistry.PolicyConfig({
            paused: paused,
            maxObjectSize: type(uint64).max,
            maxCopies: 10,
            maxCostPerUpload: type(uint128).max,
            maxActiveBytesPerAccount: type(uint128).max,
            defaultRequestTtl: 1 days,
            allowFailureCharges: false
        });
    }

    function _requestUploadStructHash(FocPlatformRegistry.RequestUploadParams memory params)
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
                address(registry),
                block.chainid
            )
        );
    }

    function _receipt(
        FocPlatformRegistry.RequestUploadParams memory params,
        uint8 completedCopies,
        uint256 actualCost
    ) private pure returns (FocPlatformRegistry.UploadReceipt memory) {
        FocPlatformRegistry.CopyReceipt[] memory copies =
            new FocPlatformRegistry.CopyReceipt[](completedCopies);
        for (uint256 i = 0; i < completedCopies; i++) {
            copies[i] = FocPlatformRegistry.CopyReceipt({
                providerId: 111 + i,
                datasetId: 222,
                pieceId: 333 + i,
                addPieceTxHash: keccak256(abi.encode("tx", i)),
                retrievalUrlHash: keccak256(abi.encode("retrieval", i)),
                isNewDataSet: i == 0
            });
        }

        return FocPlatformRegistry.UploadReceipt({
            finalizationStatus: FocPlatformRegistry.UploadFinalizationStatus.Committed,
            payer: PAYER,
            pieceCidHash: PIECE_CID_HASH,
            size: params.size,
            requestedCopies: params.requestedCopies,
            completedCopies: completedCopies,
            actualCost: actualCost,
            receiptHash: RECEIPT_HASH,
            copies: copies
        });
    }
}
