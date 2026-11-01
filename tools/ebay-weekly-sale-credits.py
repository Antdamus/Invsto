"""Prepare a private SQL import from status-filtered eBay transaction exports.

Pass a JSON list of in-scope Invsto order numbers and the three unmodified
Seller Hub export files. No customer names, titles, or addresses are imported.
"""
import argparse
import csv
import json
import re
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path


def money(text):
    value = text.strip().replace(",", "")
    if value in ("", "--", "-"):
        return None
    if not re.fullmatch(r"-?\d+(\.\d{1,2})?", value):
        raise ValueError("Unexpected money format in eBay export")
    return Decimal(value)


FEES = ("Final Value Fee - fixed", "Final Value Fee - variable", "Regulatory operating fee",
        'Very high "item not as described" fee', "Below standard performance fee",
        "International fee", "Deposit processing fee")
OTHER = ("Seller collected tax", "Charity donation")


def credit_breakdown(rows, total):
    detail = rows if len(rows) == 1 else [r for r in rows if r is not total]
    if total["Transaction currency"] != "USD" or not detail or any(
        money(r["Item subtotal"]) is None or r["Transaction currency"] not in ("", "--", "USD") for r in detail
    ):
        return None
    def amount(keys):
        return sum((money(r[k]) or Decimal(0) for r in detail for k in keys), Decimal(0))
    parts = {"item": amount(["Item subtotal"]), "shipping": amount(["Shipping and handling"]),
             "fees": amount(FEES), "other": amount(OTHER)}
    credit = money(total["Net amount"])
    if sum(parts.values()) != credit:
        return None
    return {k: str(v) for k, v in {**parts, "credit": credit}.items()}


def prepare(scope, sources, posting_month=None):
    result = {}
    for state, path in sources:
        stamp = re.fullmatch(r"Transaction-(.+)-\d+\.csv", path.name)
        checked = datetime.strptime(stamp[1], "%b-%d-%Y-%H_%M_%S%z").isoformat()
        groups = defaultdict(list)
        with path.open(encoding="utf-8-sig", newline="") as file:
            rows = csv.reader(file)
            header = next(row for row in rows if "Order number" in row)
            for row in rows:
                if len(row) != len(header):
                    continue
                rec = dict(zip(header, row))
                if rec["Type"] != "Order":
                    continue
                day = datetime.strptime(rec["Transaction creation date"], "%b %d, %Y").date().isoformat()
                if rec["Order number"] in scope or posting_month and day.startswith(posting_month + "-"):
                    groups[rec["Order number"]].append(rec)
        for order, rows in groups.items():
            if order in result:
                raise ValueError("Order appears in multiple funds states")
            totals = [r for r in rows if money(r["Net amount"]) is not None]
            if len(totals) != 1 or totals[0]["Payout currency"] != "USD":
                raise ValueError("Missing unique USD order credit")
            total = money(totals[0]["Net amount"])
            items = []
            if len(rows) > 1:
                for r in rows:
                    if r is totals[0]:
                        continue
                    sold = money(r["Item subtotal"])
                    if sold is None or not r["Quantity"].isdigit():
                        items.clear()
                        break
                    # eBay's own line-level item, shipping and fee rows. Buyer tax
                    # collected by eBay is never part of the seller's credit.
                    parts = ("Shipping and handling", "Seller collected tax", "Final Value Fee - fixed",
                             "Final Value Fee - variable", "Regulatory operating fee", 'Very high "item not as described" fee',
                             "Below standard performance fee", "International fee", "Charity donation", "Deposit processing fee")
                    line_credit = sold + sum(money(r[k]) or Decimal(0) for k in parts)
                    items.append(dict(item=r["Item ID"], txn=r["Transaction ID"], qty=int(r["Quantity"]),
                                      sold=str(sold), credit=str(line_credit)))
                if sum(Decimal(i["credit"]) for i in items) != total:
                    items.clear()
            posted = {datetime.strptime(r["Transaction creation date"], "%b %d, %Y").date().isoformat() for r in rows}
            if len(posted) != 1:
                raise ValueError("Conflicting posting dates for one order")
            result[order] = (state, checked, total, items, credit_breakdown(rows, totals[0]), posted.pop())
    if not scope.issubset(result):
        raise ValueError("The status exports do not cover exactly the selected orders")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("scope", "available", "held", "processing", "out"):
        parser.add_argument("--" + arg, type=Path, required=True)
    parser.add_argument("--breakdown-only", action="store_true",
                        help="Attach verified components only to an existing matching Seller Hub credit.")
    parser.add_argument("--posting-month", help="Only import original posting evidence, including orders outside the supplied purchase list (YYYY-MM).")
    a = parser.parse_args()
    scope = set(json.loads(a.scope.read_text(encoding="utf-8-sig")))
    if not scope or not all(re.fullmatch(r"\d{2}-\d{5}-\d{5}", n) for n in scope):
        raise ValueError("Invalid eBay order scope")
    if a.posting_month and (a.breakdown_only or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", a.posting_month)):
        raise ValueError("Choose a valid posting month or breakdown-only mode")
    rows = prepare(scope, [(s, getattr(a, s)) for s in ("available", "held", "processing")], a.posting_month)
    def q(v):
        return "'" + str(v).replace("'", "''") + "'"
    def values(vals):
        return ",\n".join("(" + ",".join(map(q, fields)) + ")" for fields in vals)
    sql = "begin;\ninsert into public.weekly_ebay_payment_observations(order_number,funds,checked_at) values\n"
    sql += values((n, v[0], v[1]) for n, v in sorted(rows.items()))
    sql += "\non conflict(order_number) do update set funds=excluded.funds,checked_at=excluded.checked_at where excluded.checked_at>=weekly_ebay_payment_observations.checked_at;\n"
    sql += "insert into public.weekly_ebay_sale_credits(order_number,credit,items,checked_at,breakdown) select n,v::numeric,i::jsonb,t::timestamptz,nullif(b,'null')::jsonb from (values\n"
    sql += values((n, v[2], json.dumps(v[3]), v[1], json.dumps(v[4])) for n, v in sorted(rows.items()))
    sql += ") as data(n,v,i,t,b) where true\non conflict(order_number) do update set credit=excluded.credit,items=excluded.items,checked_at=excluded.checked_at,breakdown=excluded.breakdown where excluded.checked_at>=weekly_ebay_sale_credits.checked_at;\ncommit;\n"
    if a.breakdown_only:
        components = [(n, v[2], v[1], json.dumps(v[4])) for n, v in sorted(rows.items()) if v[4] is not None]
        if not components:
            raise ValueError("No verified credit detail in this export")
        sql = ("update public.weekly_ebay_sale_credits c set breakdown=d.b::jsonb from (values\n"
               + values(components) + ") as d(n,v,t,b) where c.order_number=d.n and c.credit=d.v::numeric "
               "and c.checked_at=d.t::timestamptz and c.breakdown is distinct from d.b::jsonb;\n")
    if a.posting_month:
        fields = []
        for n, (_, at, _, _, p, day) in sorted(rows.items()):
            if p is None:
                raise ValueError("Incomplete USD posting breakdown")
            parts = [int(Decimal(p[k])*100) for k in ("item", "shipping", "fees", "other", "credit")]
            fields.append((n, day, *parts, at))
        sql = ("insert into public.weekly_ebay_posted_orders as p(order_number,posted_on,item,shipping,fees,other,credit,checked_at) values\n"
               + values(fields) + "\non conflict(order_number) do update set posted_on=excluded.posted_on,item=excluded.item,"
               "shipping=excluded.shipping,fees=excluded.fees,other=excluded.other,credit=excluded.credit,checked_at=excluded.checked_at "
               "where excluded.checked_at>=p.checked_at;\n")
    a.out.write_text(sql, encoding="utf-8")
    print(f"{len(rows)} order credits; {sum(len(v[3]) for v in rows.values())} reconciled itemized credits on multi-item orders; {sum(v[4] is not None for v in rows.values())} with verified shipping and fee detail.")


if __name__ == "__main__":
    main()
