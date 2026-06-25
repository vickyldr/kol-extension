import json
import sys
from pathlib import Path

from docx import Document


def clean(value):
    return " ".join((value or "").split())


def main():
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    document = Document(str(source))
    records = []

    for table_index, table in enumerate(document.tables):
        if not table.rows:
            continue
        headers = [clean(cell.text) or f"column_{index}" for index, cell in enumerate(table.rows[0].cells)]
        for row_index, row in enumerate(table.rows[1:], start=1):
            values = [clean(cell.text) for cell in row.cells]
            fields = {
                headers[index] if index < len(headers) else f"column_{index}": value
                for index, value in enumerate(values)
                if value
            }
            if not fields:
                continue
            label = values[0][:120] if values and values[0] else f"表格 {table_index + 1}"
            records.append(
                {
                    "source": "本地导出话术",
                    "stable_id": f"table-{table_index}-row-{row_index}",
                    "scene": label,
                    "fields": fields,
                }
            )

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Extracted {len(records)} knowledge records to {destination}")


if __name__ == "__main__":
    main()
