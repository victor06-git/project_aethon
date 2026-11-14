"""Pack one complete synthetic customer from the sponsor CSV for a private demo."""

import argparse
import base64
import csv
import gzip
import io
import os


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", help="Path to the full S-Pankki transaction CSV")
    parser.add_argument("customer_id", help="A synthetic customer ID, e.g. CUST00001")
    parser.add_argument("--output", required=True, help="New private file for the environment value")
    args = parser.parse_args()

    packed = io.StringIO(newline="")
    writer = csv.writer(packed, lineterminator="\n")
    count = 0
    with open(args.dataset, encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source)
        header = next(reader, [])
        if "customer_id" not in header or "bank_account_id" not in header:
            parser.error("expected the sponsor CSV header; a Git LFS pointer will not work")
        customer_column = header.index("customer_id")
        writer.writerow(header)
        for row in reader:
            if len(row) > customer_column and row[customer_column] == args.customer_id:
                writer.writerow(row)
                count += 1
    if not count:
        parser.error("no rows matched the selected customer")
    encoded = base64.b64encode(gzip.compress(packed.getvalue().encode(), mtime=0))
    if len(encoded) > 48 * 1024:
        parser.error("slice exceeds 48 KiB; select a smaller complete customer")

    # Refuse to overwrite an existing file and keep the value out of stdout.
    with os.fdopen(os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as destination:
        destination.write(encoded)
    print(f"Packed {count} rows ({len(encoded)} bytes) for REVI_DATASET_GZIP_BASE64.")


if __name__ == "__main__":
    main()
