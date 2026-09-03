// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockPerpVenue
/// @notice Stand-in for a trading venue, used so the demo runs without depending on
///         a live DEX. It exists to make two things observable.
///
/// 1. `place` reverts on slippage, the way a real venue does. That lets the tests show
///    a failing operation consuming only its own nonce lane.
/// 2. Every order's primary state lives in a slot derived from its own `orderId`.
///    The global `landedCount` is shared test instrumentation, so this contract is
///    useful for observing order but is not a parallel-execution benchmark.
contract MockPerpVenue {
    struct Order {
        uint256 seq; // global landing order, 0 means never landed
        uint256 qty;
        uint256 fillPx;
        address trader;
        bool cancelled;
    }

    /// @notice Current mark price, 18 decimals.
    uint256 public markPx;

    /// @notice Monotonic counter incremented on every landed call, so tests and scripts
    ///         can read back the order in which operations actually executed.
    uint256 public landedCount;

    mapping(uint256 orderId => Order) public orders;

    event Placed(uint256 indexed orderId, address indexed trader, uint256 seq, uint256 qty, uint256 fillPx);
    event Cancelled(uint256 indexed orderId, uint256 seq);
    event MarkUpdated(uint256 markPx);

    error Slippage(uint256 limitPx, uint256 markPx);
    error DuplicateOrder(uint256 orderId);
    error UnknownOrder(uint256 orderId);

    constructor(uint256 initialMarkPx) {
        markPx = initialMarkPx;
        emit MarkUpdated(initialMarkPx);
    }

    function setMark(uint256 newMarkPx) external {
        markPx = newMarkPx;
        emit MarkUpdated(newMarkPx);
    }

    /// @notice Buy `qty` at up to `limitPx`. Reverts if the mark has moved through the limit.
    function place(uint256 orderId, uint256 qty, uint256 limitPx) external {
        if (orders[orderId].seq != 0) revert DuplicateOrder(orderId);
        uint256 mark = markPx;
        if (limitPx < mark) revert Slippage(limitPx, mark);

        uint256 seq = ++landedCount;
        orders[orderId] = Order({seq: seq, qty: qty, fillPx: mark, trader: msg.sender, cancelled: false});
        emit Placed(orderId, msg.sender, seq, qty, mark);
    }

    function cancel(uint256 orderId) external {
        Order storage order = orders[orderId];
        if (order.seq == 0) revert UnknownOrder(orderId);
        order.cancelled = true;
        emit Cancelled(orderId, ++landedCount);
    }

    function isFilled(uint256 orderId) external view returns (bool) {
        return orders[orderId].seq != 0;
    }

    /// @notice Position of this order in the global landing sequence, 0 if it never landed.
    function landingSeq(uint256 orderId) external view returns (uint256) {
        return orders[orderId].seq;
    }
}
