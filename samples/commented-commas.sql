-- Commented-out code with commas must stay commented out
SELECT
    o.id,
    -- o.legacy_code,
    -- o.old_total, o.old_tax,
    o.total, /* o.discount, */
    o.created_at -- , o.updated_at
FROM orders o
WHERE o.status = 'paid' -- and o.region = 'eu',
  AND o.total > 0;
