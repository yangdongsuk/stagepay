// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Stagepay, IERC20} from "../src/Stagepay.sol";

contract MockUSDC {
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Takes a 1% cut on every transfer, to prove the escrow refuses under-collateralised deposits.
contract FeeToken is MockUSDC {
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - amount / 100;
        return true;
    }
}

contract StagepayTest is Test {
    Stagepay esc;
    MockUSDC usdc;
    address client = makeAddr("client");
    address freelancer = makeAddr("freelancer");
    address stranger = makeAddr("stranger");
    uint64 constant REVIEW = 3 days;

    function setUp() public {
        vm.warp(1_790_000_000);
        esc = new Stagepay();
        usdc = new MockUSDC();
        usdc.mint(client, 1_000_000e6);
        vm.prank(client);
        usdc.approve(address(esc), type(uint256).max);
    }

    function _create(uint128 a, uint128 b) internal returns (uint256 id) {
        uint128[] memory amounts = new uint128[](2);
        amounts[0] = a;
        amounts[1] = b;
        uint64[] memory deadlines = new uint64[](2);
        deadlines[0] = uint64(block.timestamp + 7 days);
        deadlines[1] = uint64(block.timestamp + 14 days);
        vm.prank(client);
        id = esc.createJob(freelancer, IERC20(address(usdc)), amounts, deadlines, REVIEW, keccak256("terms v1"));
    }

    function _status(uint256 id, uint256 i) internal view returns (Stagepay.Status) {
        return esc.getMilestone(id, i).status;
    }

    // ------------------------------------------------------------ create

    function test_createJob_pullsFullAmount() public {
        uint256 id = _create(100e6, 250e6);
        assertEq(id, 1);
        assertEq(usdc.balanceOf(address(esc)), 350e6);
        (address c, address f,,,, uint256 total, uint256 settled) = esc.jobs(id);
        assertEq(c, client);
        assertEq(f, freelancer);
        assertEq(total, 350e6);
        assertEq(settled, 0);
        assertEq(esc.milestoneCount(id), 2);
        assertEq(uint8(_status(id, 0)), uint8(Stagepay.Status.Funded));
    }

    function test_createJob_rejectsBadParams() public {
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 1e6;
        uint64[] memory deadlines = new uint64[](1);
        deadlines[0] = uint64(block.timestamp + 1 days);
        IERC20 t = IERC20(address(usdc));

        vm.startPrank(client);
        vm.expectRevert(Stagepay.InvalidParams.selector); // self as freelancer
        esc.createJob(client, t, amounts, deadlines, REVIEW, 0);
        vm.expectRevert(Stagepay.InvalidParams.selector); // review period too short
        esc.createJob(freelancer, t, amounts, deadlines, 10 minutes, 0);
        vm.expectRevert(Stagepay.InvalidParams.selector); // review period too long
        esc.createJob(freelancer, t, amounts, deadlines, 31 days, 0);
        deadlines[0] = uint64(block.timestamp);
        vm.expectRevert(Stagepay.InvalidParams.selector); // deadline not in the future
        esc.createJob(freelancer, t, amounts, deadlines, REVIEW, 0);
        deadlines[0] = uint64(block.timestamp + 1 days);
        amounts[0] = 0;
        vm.expectRevert(Stagepay.InvalidParams.selector); // zero amount
        esc.createJob(freelancer, t, amounts, deadlines, REVIEW, 0);
        vm.stopPrank();
    }

    function test_createJob_rejectsFeeOnTransferToken() public {
        FeeToken fee = new FeeToken();
        fee.mint(client, 100e6);
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 100e6;
        uint64[] memory deadlines = new uint64[](1);
        deadlines[0] = uint64(block.timestamp + 1 days);
        vm.startPrank(client);
        fee.approve(address(esc), type(uint256).max);
        vm.expectRevert(Stagepay.TransferFailed.selector);
        esc.createJob(freelancer, IERC20(address(fee)), amounts, deadlines, REVIEW, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------- happy path

    function test_submitThenApprove_paysFreelancer() public {
        uint256 id = _create(100e6, 250e6);
        vm.prank(freelancer);
        esc.submit(id, 0, "v1 delivered");
        vm.prank(client);
        esc.approve(id, 0);
        assertEq(usdc.balanceOf(freelancer), 100e6);
        assertEq(uint8(_status(id, 0)), uint8(Stagepay.Status.Released));
        (,,,,,, uint256 settled) = esc.jobs(id);
        assertEq(settled, 100e6);
    }

    function test_claimAfterSilentReview() public {
        uint256 id = _create(100e6, 250e6);
        vm.prank(freelancer);
        esc.submit(id, 1, "");
        assertEq(esc.claimableAt(id, 1), block.timestamp + REVIEW);

        vm.warp(block.timestamp + REVIEW - 1);
        vm.prank(freelancer);
        vm.expectRevert(Stagepay.TooEarly.selector);
        esc.claim(id, 1);

        vm.warp(block.timestamp + 1);
        vm.prank(freelancer);
        esc.claim(id, 1);
        assertEq(usdc.balanceOf(freelancer), 250e6);
    }

    // ------------------------------------------------------- access rules

    function test_onlyPartiesCanAct() public {
        uint256 id = _create(100e6, 250e6);
        vm.prank(stranger);
        vm.expectRevert(Stagepay.NotFreelancer.selector);
        esc.submit(id, 0, "");
        vm.prank(client);
        vm.expectRevert(Stagepay.NotFreelancer.selector);
        esc.submit(id, 0, "");

        vm.prank(freelancer);
        esc.submit(id, 0, "");
        vm.prank(freelancer);
        vm.expectRevert(Stagepay.NotClient.selector);
        esc.approve(id, 0);
        vm.prank(stranger);
        vm.expectRevert(Stagepay.NotParty.selector);
        esc.proposeSplit(id, 0, 1);
    }

    function test_cannotApproveUnsubmittedOrTwice() public {
        uint256 id = _create(100e6, 250e6);
        vm.prank(client);
        vm.expectRevert(Stagepay.BadStatus.selector);
        esc.approve(id, 0);

        vm.prank(freelancer);
        esc.submit(id, 0, "");
        vm.prank(client);
        esc.approve(id, 0);
        vm.prank(client);
        vm.expectRevert(Stagepay.BadStatus.selector);
        esc.approve(id, 0);
        vm.prank(freelancer);
        vm.expectRevert(Stagepay.BadStatus.selector);
        esc.claim(id, 0);
    }

    // ---------------------------------------------------------- revisions

    function test_revisionReopensAndExtendsDeadline() public {
        uint256 id = _create(100e6, 250e6);
        vm.warp(block.timestamp + 7 days - 1 hours); // just before milestone 0 deadline
        vm.prank(freelancer);
        esc.submit(id, 0, "");
        vm.prank(client);
        esc.requestRevision(id, 0, "fix the header");
        Stagepay.Milestone memory m = esc.getMilestone(id, 0);
        assertEq(uint8(m.status), uint8(Stagepay.Status.Funded));
        assertEq(m.revisions, 1);
        assertGe(m.deadline, block.timestamp + REVIEW); // freelancer got time to resubmit

        // client cannot cancel while the extended deadline is running
        vm.prank(client);
        vm.expectRevert(Stagepay.TooEarly.selector);
        esc.cancelExpired(id, 0);
    }

    function test_revisionOnlyInsideReviewWindow() public {
        uint256 id = _create(100e6, 250e6);
        vm.prank(freelancer);
        esc.submit(id, 0, "");
        vm.warp(block.timestamp + REVIEW);
        vm.prank(client);
        vm.expectRevert(Stagepay.TooEarly.selector);
        esc.requestRevision(id, 0, "too late");
    }

    function test_revisionLimitStopsStalling() public {
        uint256 id = _create(100e6, 250e6);
        for (uint256 i; i < esc.MAX_REVISIONS(); ++i) {
            vm.prank(freelancer);
            esc.submit(id, 0, "");
            vm.prank(client);
            esc.requestRevision(id, 0, "again");
        }
        vm.prank(freelancer);
        esc.submit(id, 0, "final");
        vm.prank(client);
        vm.expectRevert(Stagepay.RevisionLimit.selector);
        esc.requestRevision(id, 0, "one more");

        vm.warp(block.timestamp + REVIEW);
        vm.prank(freelancer);
        esc.claim(id, 0);
        assertEq(usdc.balanceOf(freelancer), 100e6);
    }

    // ------------------------------------------------------------ refunds

    function test_cancelExpired_onlyAfterDeadlineAndIfUnsubmitted() public {
        uint256 id = _create(100e6, 250e6);
        vm.prank(client);
        vm.expectRevert(Stagepay.TooEarly.selector);
        esc.cancelExpired(id, 0);

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(client);
        esc.cancelExpired(id, 0);
        assertEq(usdc.balanceOf(client), 1_000_000e6 - 250e6);
        assertEq(uint8(_status(id, 0)), uint8(Stagepay.Status.Refunded));

        // a submitted milestone cannot be cancelled even after its deadline
        vm.prank(freelancer);
        esc.submit(id, 1, "");
        vm.warp(block.timestamp + 30 days);
        vm.prank(client);
        vm.expectRevert(Stagepay.BadStatus.selector);
        esc.cancelExpired(id, 1);
    }

    function test_freelancerCanRefundVoluntarily() public {
        uint256 id = _create(100e6, 250e6);
        vm.prank(freelancer);
        esc.refundByFreelancer(id, 1);
        assertEq(usdc.balanceOf(client), 1_000_000e6 - 100e6);
    }

    // ------------------------------------------------------------- splits

    function test_splitNeedsTheOtherParty() public {
        uint256 id = _create(100e6, 250e6);
        vm.prank(client);
        esc.proposeSplit(id, 0, 60e6);

        vm.prank(client);
        vm.expectRevert(Stagepay.NoSplitProposed.selector); // cannot accept own proposal
        esc.acceptSplit(id, 0, 60e6);
        vm.prank(freelancer);
        vm.expectRevert(Stagepay.InvalidParams.selector); // must match the proposal
        esc.acceptSplit(id, 0, 90e6);

        vm.prank(freelancer);
        esc.acceptSplit(id, 0, 60e6);
        assertEq(usdc.balanceOf(freelancer), 60e6);
        assertEq(usdc.balanceOf(client), 1_000_000e6 - 350e6 + 40e6);
        assertEq(uint8(_status(id, 0)), uint8(Stagepay.Status.Split));
    }

    function test_submitClearsStaleSplit() public {
        uint256 id = _create(100e6, 250e6);
        vm.prank(client);
        esc.proposeSplit(id, 0, 10e6);
        vm.prank(freelancer);
        esc.submit(id, 0, "done after all");
        vm.prank(freelancer);
        vm.expectRevert(Stagepay.NoSplitProposed.selector);
        esc.acceptSplit(id, 0, 10e6);
    }

    // --------------------------------------------------------- invariants

    /// Whatever sequence of outcomes happens, every unit deposited ends up with the client or the
    /// freelancer, and nothing is left behind in the escrow.
    function testFuzz_fundsConserved(uint128 a, uint128 b, uint8 outcomeA, uint8 outcomeB, uint64 split) public {
        a = uint128(bound(a, 1, 4e11));
        b = uint128(bound(b, 1, 4e11));
        uint256 id = _create(a, b);
        _settle(id, 0, a, outcomeA % 5, split);
        _settle(id, 1, b, outcomeB % 5, split);
        assertEq(usdc.balanceOf(address(esc)), 0);
        assertEq(usdc.balanceOf(client) + usdc.balanceOf(freelancer), 1_000_000e6);
        (,,,,, uint256 total, uint256 settled) = esc.jobs(id);
        assertEq(total, settled);
    }

    function _settle(uint256 id, uint256 i, uint128 amount, uint8 outcome, uint64 split) internal {
        if (outcome == 0) {
            vm.prank(freelancer);
            esc.submit(id, i, "");
            vm.prank(client);
            esc.approve(id, i);
        } else if (outcome == 1) {
            vm.prank(freelancer);
            esc.submit(id, i, "");
            vm.warp(block.timestamp + REVIEW);
            vm.prank(freelancer);
            esc.claim(id, i);
        } else if (outcome == 2) {
            vm.warp(esc.getMilestone(id, i).deadline + 1);
            vm.prank(client);
            esc.cancelExpired(id, i);
        } else if (outcome == 3) {
            vm.prank(freelancer);
            esc.refundByFreelancer(id, i);
        } else {
            uint128 toF = uint128(bound(split, 0, amount));
            vm.prank(freelancer);
            esc.proposeSplit(id, i, toF);
            vm.prank(client);
            esc.acceptSplit(id, i, toF);
        }
    }
}
