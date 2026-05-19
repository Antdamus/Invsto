create index if not exists ebay_orders_label_metadata_gin_idx
  on public.ebay_orders using gin(label_metadata jsonb_path_ops);

create index if not exists ebay_orders_label_tracking_number_idx
  on public.ebay_orders ((label_metadata ->> 'trackingNumber'));

create index if not exists ebay_orders_label_shipping_barcode_number_idx
  on public.ebay_orders ((label_metadata ->> 'shippingBarcodeNumber'));

create index if not exists ebay_orders_ebay_shipment_id_idx
  on public.ebay_orders (ebay_shipment_id);

create index if not exists ebay_orders_label_id_metadata_idx
  on public.ebay_orders ((label_metadata ->> 'labelId'));

create index if not exists ebay_order_label_events_label_metadata_gin_idx
  on public.ebay_order_label_events using gin(label_metadata jsonb_path_ops);

create index if not exists ebay_order_label_events_label_tracking_number_idx
  on public.ebay_order_label_events ((label_metadata ->> 'trackingNumber'));

create index if not exists ebay_order_label_events_label_shipping_barcode_number_idx
  on public.ebay_order_label_events ((label_metadata ->> 'shippingBarcodeNumber'));

create index if not exists ebay_order_label_events_shipment_id_idx
  on public.ebay_order_label_events (shipment_id);

create index if not exists ebay_order_label_events_label_id_metadata_idx
  on public.ebay_order_label_events ((label_metadata ->> 'labelId'));
