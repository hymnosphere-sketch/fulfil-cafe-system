"""SQLAlchemy models (BE-02). One class per table in DATABASE_DESIGN section 2.

Design notes
- UUIDs are stored as 36-character text; quantities as 64-bit integers.
- Event timestamps (created_at, updated_at) are stored as canonical UTC text
  such as '2026-11-18T02:05:00.000Z'. That fixed-width format sorts correctly
  as plain text and avoids SQLite timezone surprises.
- Purchase and expiration dates are real DATE columns (calendar dates).
- Stock balances are NOT stored: they are always summed from movements
  (items) or allocations (batches), so they can never drift.
"""
import datetime

from sqlalchemy import (BigInteger, Boolean, Date, ForeignKey, Index, String, Text,
                        UniqueConstraint, CheckConstraint)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Category(Base):
    __tablename__ = "categories"
    category_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    normalized_name: Mapped[str] = mapped_column(Text, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[str] = mapped_column(String(24))
    updated_at: Mapped[str] = mapped_column(String(24))
    __table_args__ = (
        CheckConstraint("length(trim(name)) > 0", name="ck_category_name"),
        CheckConstraint("length(trim(normalized_name)) > 0", name="ck_category_normalized"),
    )


class Item(Base):
    __tablename__ = "inventory_items"
    item_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    category_id: Mapped[str] = mapped_column(
        ForeignKey("categories.category_id", ondelete="RESTRICT"), index=True)
    name: Mapped[str] = mapped_column(Text)
    normalized_name: Mapped[str] = mapped_column(Text, index=True)
    unit_of_measurement: Mapped[str] = mapped_column(String(32))
    minimum_stock_level: Mapped[int] = mapped_column(BigInteger)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[str] = mapped_column(String(24))
    updated_at: Mapped[str] = mapped_column(String(24))
    __table_args__ = (
        CheckConstraint("minimum_stock_level >= 0", name="ck_item_minimum"),
        CheckConstraint("length(trim(name)) > 0", name="ck_item_name"),
        CheckConstraint("length(trim(normalized_name)) > 0", name="ck_item_normalized"),
    )


class Batch(Base):
    __tablename__ = "stock_batches"
    batch_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("inventory_items.item_id", ondelete="RESTRICT"), index=True)
    received_quantity: Mapped[int] = mapped_column(BigInteger)
    purchase_date: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
    purchase_cost: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    expiration_date: Mapped[datetime.date | None] = mapped_column(Date, nullable=True, index=True)
    created_at: Mapped[str] = mapped_column(String(24))
    __table_args__ = (
        CheckConstraint("received_quantity > 0", name="ck_batch_received"),
        CheckConstraint("purchase_cost IS NULL OR purchase_cost >= 0", name="ck_batch_cost"),
    )


class Movement(Base):
    __tablename__ = "stock_movements"
    movement_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("inventory_items.item_id", ondelete="RESTRICT"), index=True)
    movement_type: Mapped[str] = mapped_column(String(32))
    quantity_change: Mapped[int] = mapped_column(BigInteger)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    recorded_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(String(24))
    __table_args__ = (
        CheckConstraint("quantity_change != 0", name="ck_movement_nonzero"),
        CheckConstraint(
            "movement_type IN ('initial_stock','stock_in','stock_out','wastage',"
            "'positive_adjustment','negative_adjustment')", name="ck_movement_type"),
        CheckConstraint(
            "(movement_type IN ('initial_stock','stock_in','positive_adjustment') "
            "AND quantity_change > 0) OR "
            "(movement_type IN ('stock_out','wastage','negative_adjustment') "
            "AND quantity_change < 0)", name="ck_movement_sign"),
        CheckConstraint(
            "movement_type NOT IN ('wastage','positive_adjustment','negative_adjustment') "
            "OR (reason IS NOT NULL AND length(trim(reason)) > 0)", name="ck_movement_reason"),
    )


class Allocation(Base):
    __tablename__ = "batch_allocations"
    allocation_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    movement_id: Mapped[str] = mapped_column(ForeignKey("stock_movements.movement_id", ondelete="RESTRICT"), index=True)
    batch_id: Mapped[str] = mapped_column(ForeignKey("stock_batches.batch_id", ondelete="RESTRICT"), index=True)
    quantity_change: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (
        UniqueConstraint("movement_id", "batch_id", name="uq_allocation_pair"),
        CheckConstraint("quantity_change != 0", name="ck_allocation_nonzero"),
    )


class ProcessedOperation(Base):
    """Server-side receipt. One row per accepted command (idempotency)."""
    __tablename__ = "processed_operations"
    operation_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    operation_type: Mapped[str] = mapped_column(String(32))
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    fingerprint_profile: Mapped[str] = mapped_column(String(32))
    processed_at: Mapped[str] = mapped_column(String(24))
    processing_result: Mapped[str] = mapped_column(Text)  # JSON text


class Setting(Base):
    __tablename__ = "application_settings"
    setting_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text)  # JSON text
    updated_at: Mapped[str] = mapped_column(String(24))


Index("ix_movements_item_created", Movement.item_id, Movement.created_at)
Index("ix_movements_type_created", Movement.movement_type, Movement.created_at)
Index("ix_movements_created", Movement.created_at)
