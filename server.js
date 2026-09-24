const express = require("express")
const cors = require("cors")
const { execFile } = require("child_process")

const app = express()

const PORT = process.env.PORT || 9100
const HOST = "0.0.0.0"

app.use(cors())

app.use(
  express.json({
    limit: "2mb",
  })
)


// ============================================================
// GET DEFAULT WINDOWS PRINTER
// ============================================================

function getDefaultPrinter() {
  return new Promise(
    (resolve, reject) => {
      const powershellScript = `
Get-CimInstance Win32_Printer |
Where-Object { $_.Default -eq $true } |
Select-Object Name, PrinterStatus, Default, WorkOffline, PrinterState |
ConvertTo-Json -Compress
`

      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          powershellScript,
        ],
        {
          windowsHide: true,
          encoding: "utf8",
        },
        (
          error,
          stdout,
          stderr
        ) => {
          if (error) {
            console.error(
              "Printer detection error:",
              stderr ||
                error.message
            )

            reject(
              new Error(
                stderr?.trim() ||
                  error.message ||
                  "Failed to detect printer."
              )
            )

            return
          }

          try {
            if (
              !stdout.trim()
            ) {
              resolve(null)
              return
            }

            const printer =
              JSON.parse(
                stdout.trim()
              )

            resolve(
              printer
            )
          } catch (error) {
            console.error(
              "Printer JSON parse error:",
              error
            )

            reject(error)
          }
        }
      )
    }
  )
}


// ============================================================
// RAW PRINT
// ============================================================

function rawPrint(
  printerName,
  receiptText
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const base64Text =
        Buffer.from(
          receiptText,
          "ascii"
        ).toString(
          "base64"
        )

      const safePrinterName =
        String(
          printerName
        )
          .replace(
            /\\/g,
            "\\\\"
          )
          .replace(
            /"/g,
            '\\"'
          )

      const powershellScript = `
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class RawPrinter
{
    [StructLayout(
        LayoutKind.Sequential,
        CharSet = CharSet.Unicode
    )]
    public class DOCINFO
    {
        [MarshalAs(UnmanagedType.LPWStr)]
        public string pDocName;

        [MarshalAs(UnmanagedType.LPWStr)]
        public string pOutputFile;

        [MarshalAs(UnmanagedType.LPWStr)]
        public string pDataType;
    }

    [DllImport(
        "winspool.drv",
        SetLastError = true,
        CharSet = CharSet.Unicode
    )]
    public static extern bool OpenPrinter(
        string pPrinterName,
        out IntPtr phPrinter,
        IntPtr pDefault
    );

    [DllImport(
        "winspool.drv",
        SetLastError = true
    )]
    public static extern bool ClosePrinter(
        IntPtr hPrinter
    );

    [DllImport(
        "winspool.drv",
        SetLastError = true,
        CharSet = CharSet.Unicode
    )]
    public static extern int StartDocPrinter(
        IntPtr hPrinter,
        int level,
        [In] DOCINFO di
    );

    [DllImport(
        "winspool.drv",
        SetLastError = true
    )]
    public static extern bool EndDocPrinter(
        IntPtr hPrinter
    );

    [DllImport(
        "winspool.drv",
        SetLastError = true
    )]
    public static extern int StartPagePrinter(
        IntPtr hPrinter
    );

    [DllImport(
        "winspool.drv",
        SetLastError = true
    )]
    public static extern bool EndPagePrinter(
        IntPtr hPrinter
    );

    [DllImport(
        "winspool.drv",
        SetLastError = true
    )]
    public static extern bool WritePrinter(
        IntPtr hPrinter,
        IntPtr pBytes,
        int dwCount,
        out int dwWritten
    );

    public static void SendBytes(
        string printerName,
        byte[] bytes
    )
    {
        IntPtr hPrinter =
            IntPtr.Zero;

        // ----------------------------------------------------
        // OPEN PRINTER
        // ----------------------------------------------------

        if (
            !OpenPrinter(
                printerName,
                out hPrinter,
                IntPtr.Zero
            )
        )
        {
            throw new Exception(
                "OpenPrinter failed. Win32 Error: " +
                Marshal.GetLastWin32Error()
            );
        }

        try
        {
            // ------------------------------------------------
            // DOCUMENT INFO
            // ------------------------------------------------

            DOCINFO docInfo =
                new DOCINFO();

            docInfo.pDocName =
                "ELKJ POS Receipt";

            docInfo.pOutputFile =
                null;

            docInfo.pDataType =
                "RAW";

            // ------------------------------------------------
            // START DOCUMENT
            // ------------------------------------------------

            int jobId =
                StartDocPrinter(
                    hPrinter,
                    1,
                    docInfo
                );

            if (
                jobId == 0
            )
            {
                throw new Exception(
                    "StartDocPrinter failed. Win32 Error: " +
                    Marshal.GetLastWin32Error()
                );
            }

            try
            {
                // --------------------------------------------
                // START PAGE
                // --------------------------------------------

                int pageStarted =
                    StartPagePrinter(
                        hPrinter
                    );

                if (
                    pageStarted == 0
                )
                {
                    throw new Exception(
                        "StartPagePrinter failed. Win32 Error: " +
                        Marshal.GetLastWin32Error()
                    );
                }

                try
                {
                    // ----------------------------------------
                    // ALLOCATE MEMORY
                    // ----------------------------------------

                    IntPtr unmanagedPointer =
                        Marshal.AllocHGlobal(
                            bytes.Length
                        );

                    try
                    {
                        // ------------------------------------
                        // COPY BYTES
                        // ------------------------------------

                        Marshal.Copy(
                            bytes,
                            0,
                            unmanagedPointer,
                            bytes.Length
                        );

                        // ------------------------------------
                        // WRITE PRINTER
                        // ------------------------------------

                        int written = 0;

                        bool success =
                            WritePrinter(
                                hPrinter,
                                unmanagedPointer,
                                bytes.Length,
                                out written
                            );

                        if (
                            !success
                        )
                        {
                            throw new Exception(
                                "WritePrinter failed. Win32 Error: " +
                                Marshal.GetLastWin32Error()
                            );
                        }

                        // ------------------------------------
                        // VERIFY
                        // ------------------------------------
                        // IMPORTANT:
                        // C# uses !=
                        // NOT !==
                        // ------------------------------------

                        if (
                            written !=
                            bytes.Length
                        )
                        {
                            throw new Exception(
                                "Printer only received " +
                                written +
                                " of " +
                                bytes.Length +
                                " bytes."
                            );
                        }
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(
                            unmanagedPointer
                        );
                    }
                }
                finally
                {
                    EndPagePrinter(
                        hPrinter
                    );
                }
            }
            finally
            {
                EndDocPrinter(
                    hPrinter
                );
            }
        }
        finally
        {
            ClosePrinter(
                hPrinter
            );
        }
    }
}
"@

$base64 = "${base64Text}"

$bytes =
    [Convert]::FromBase64String(
        $base64
    )

[RawPrinter]::SendBytes(
    "${safePrinterName}",
    $bytes
)

Write-Output "RAW_PRINT_SUCCESS"
`

      console.log("")
      console.log(
        "======================================"
      )
      console.log(
        "RAW ESC/POS PRINT"
      )
      console.log(
        "======================================"
      )
      console.log(
        "Printer:",
        printerName
      )
      console.log(
        "Bytes:",
        Buffer.from(
          receiptText,
          "ascii"
        ).length
      )
      console.log(
        "======================================"
      )

      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          powershellScript,
        ],
        {
          windowsHide: true,
          encoding: "utf8",
          maxBuffer:
            1024 * 1024,
        },
        (
          error,
          stdout,
          stderr
        ) => {
          console.log("")
          console.log(
            "PowerShell stdout:"
          )

          console.log(
            stdout ||
              "(empty)"
          )

          console.log("")
          console.log(
            "PowerShell stderr:"
          )

          console.log(
            stderr ||
              "(empty)"
          )

          if (error) {
            console.error("")
            console.error(
              "RAW PRINT ERROR:"
            )

            console.error(
              error
            )

            reject(
              new Error(
                stderr?.trim() ||
                  error.message ||
                  "Failed to send RAW print job."
              )
            )

            return
          }

          resolve({
            stdout,
            stderr,
          })
        }
      )
    }
  )
}


// ============================================================
// MONEY
// ============================================================

function formatMoney(
  value
) {
  return Number(
    value ?? 0
  ).toFixed(2)
}


// ============================================================
// PAD RIGHT
// ============================================================

function padRight(
  text,
  length
) {
  text = String(
    text ?? ""
  )

  if (
    text.length >=
    length
  ) {
    return text.substring(
      0,
      length
    )
  }

  return (
    text +
    " ".repeat(
      length -
        text.length
    )
  )
}


// ============================================================
// PAD LEFT
// ============================================================

function padLeft(
  text,
  length
) {
  text = String(
    text ?? ""
  )

  if (
    text.length >=
    length
  ) {
    return text.substring(
      0,
      length
    )
  }

  return (
    " ".repeat(
      length -
        text.length
    ) +
    text
  )
}


// ============================================================
// FORMAT ITEM
// ============================================================

function formatItem(
  name,
  qty,
  price
) {
  const width = 32

  const quantity =
    Number(qty ?? 0)

  const unitPrice =
    Number(price ?? 0)

  const total =
    quantity *
    unitPrice

  const right =
    `${quantity} x ${formatMoney(
      unitPrice
    )} ${formatMoney(
      total
    )}`

  const available =
    width -
    right.length -
    1

  const productName =
    String(
      name ?? "Item"
    ).substring(
      0,
      Math.max(
        available,
        1
      )
    )

  return (
    padRight(
      productName,
      Math.max(
        available,
        1
      )
    ) +
    " " +
    right
  )
}


// ============================================================
// CREATE SALE RECEIPT
// ============================================================

function createSaleReceipt(
  sale
) {
  const ESC =
    "\x1B"

  const GS =
    "\x1D"

  const center =
    ESC +
    "a" +
    "\x01"

  const left =
    ESC +
    "a" +
    "\x00"

  const boldOn =
    ESC +
    "E" +
    "\x01"

  const boldOff =
    ESC +
    "E" +
    "\x00"

  let receipt = ""

  // ==========================================================
  // INIT
  // ==========================================================

  receipt +=
    ESC + "@"

  // ==========================================================
  // HEADER
  // ==========================================================

  receipt +=
    center

  receipt +=
    boldOn

  receipt +=
    "ELKJ IT SOLUTIONS\n"

  receipt +=
    boldOff

  receipt +=
    "POINT OF SALE\n"

  receipt +=
    "--------------------------------\n"

  // ==========================================================
  // SALE INFO
  // ==========================================================

  receipt +=
    left

  const invoice =
    sale?.invoice ??
    sale?.invoice_number ??
    "-"

  const customer =
    sale?.customer_name ??
    "Walk-in Customer"

  let saleDate = ""

  if (
    sale?.created_at
  ) {
    const parsedDate =
      new Date(
        sale.created_at
      )

    if (
      !Number.isNaN(
        parsedDate.getTime()
      )
    ) {
      saleDate =
        parsedDate.toLocaleString()
    }
  }

  if (!saleDate) {
    saleDate =
      new Date().toLocaleString()
  }

  receipt +=
    `Invoice: ${invoice}\n`

  receipt +=
    `Customer: ${customer}\n`

  receipt +=
    `Date: ${saleDate}\n`

  receipt +=
    "--------------------------------\n"

  // ==========================================================
  // ITEMS
  // ==========================================================

  const items =
    Array.isArray(
      sale?.sale_items
    )
      ? sale.sale_items
      : Array.isArray(
          sale?.items
        )
        ? sale.items
        : []

  receipt +=
    "ITEMS\n"

  receipt +=
    "--------------------------------\n"

  if (
    items.length > 0
  ) {
    items.forEach(
      (item) => {
        const product =
          item?.product ??
          {}

        const name =
          item?.product_name ??
          product?.name ??
          item?.name ??
          "Product"

        const quantity =
          item?.quantity ??
          0

        const unitPrice =
          item?.unit_price ??
          item?.price ??
          0

        receipt +=
          formatItem(
            name,
            quantity,
            unitPrice
          ) +
          "\n"
      }
    )
  } else {
    receipt +=
      "No item details available\n"
  }

  receipt +=
    "--------------------------------\n"

  // ==========================================================
  // AMOUNTS
  // ==========================================================

  const subtotal =
    Number(
      sale?.subtotal ??
        0
    )

  const discount =
    Number(
      sale?.discount ??
        0
    )

  const tax =
    Number(
      sale?.tax ??
        0
    )

  const total =
    Number(
      sale?.total_amount ??
        sale?.total ??
        0
    )

  const amountPaid =
    Number(
      sale?.amount_paid ??
        0
    )

  const change =
    Number(
      sale?.change_amount ??
        0
    )

  const paymentMethod =
    sale?.payment_method ??
    "Cash"

  receipt +=
    `Subtotal: ${padLeft(
      formatMoney(
        subtotal
      ),
      20
    )}\n`

  receipt +=
    `Discount: ${padLeft(
      formatMoney(
        discount
      ),
      20
    )}\n`

  receipt +=
    `Tax: ${padLeft(
      formatMoney(
        tax
      ),
      20
    )}\n`

  receipt +=
    "--------------------------------\n"

  receipt +=
    boldOn

  receipt +=
    `TOTAL: ${padLeft(
      formatMoney(
        total
      ),
      19
    )}\n`

  receipt +=
    boldOff

  receipt +=
    "--------------------------------\n"

  receipt +=
    `Payment: ${paymentMethod}\n`

  receipt +=
    `Paid: ${padLeft(
      formatMoney(
        amountPaid
      ),
      20
    )}\n`

  receipt +=
    `Change: ${padLeft(
      formatMoney(
        change
      ),
      18
    )}\n`

  // ==========================================================
  // PROVIDER
  // ==========================================================

  if (
    sale?.provider
  ) {
    receipt +=
      `Provider: ${sale.provider}\n`
  }

  // ==========================================================
  // REFERENCE
  // ==========================================================

  if (
    sale?.reference_number
  ) {
    receipt +=
      `Reference: ${sale.reference_number}\n`
  }

  // ==========================================================
  // INSTALLMENT
  // ==========================================================

  if (
    sale?.installment_months
  ) {
    receipt +=
      `Term: ${sale.installment_months} months\n`
  }

  // ==========================================================
  // FOOTER
  // ==========================================================

  receipt +=
    "\n"

  receipt +=
    center

  receipt +=
    boldOn

  receipt +=
    "Thank you for your purchase!\n"

  receipt +=
    boldOff

  receipt +=
    "Please come again.\n"

  receipt +=
    "\n\n\n"

  // ==========================================================
  // CUT
  // ==========================================================

  receipt +=
    GS +
    "V" +
    "\x00"

  return receipt
}


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,
      service:
        "ELKJ POS Print Service",
      status:
        "online",
    })
  }
)


// ============================================================
// GET PRINTER
// ============================================================

app.get(
  "/printer",
  async (
    req,
    res
  ) => {
    try {
      const printer =
        await getDefaultPrinter()

      if (!printer) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "No default printer found.",
          })
      }

      return res.json({
        success: true,
        printer,
      })
    } catch (error) {
      console.error(
        error
      )

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Unable to detect default printer.",
          error:
            error.message,
        })
    }
  }
)


// ============================================================
// TEST PRINT
// ============================================================

app.post(
  "/print-test",
  async (
    req,
    res
  ) => {
    try {
      const printer =
        await getDefaultPrinter()

      if (!printer) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "No default printer found.",
          })
      }

      if (
        printer.WorkOffline ===
        true
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              `Printer "${printer.Name}" is offline.`,
          })
      }

      const testSale = {
        invoice:
          "TEST-000001",

        customer_name:
          "Test Customer",

        created_at:
          new Date().toISOString(),

        subtotal:
          250,

        discount:
          0,

        tax:
          0,

        total_amount:
          250,

        payment_method:
          "Cash",

        amount_paid:
          300,

        change_amount:
          50,

        sale_items: [
          {
            product_name:
              "Sample Product",

            quantity:
              2,

            unit_price:
              100,
          },

          {
            product_name:
              "Test Item",

            quantity:
              1,

            unit_price:
              50,
          },
        ],
      }

      const receipt =
        createSaleReceipt(
          testSale
        )

      await rawPrint(
        printer.Name,
        receipt
      )

      return res.json({
        success: true,
        message:
          "Test receipt sent successfully.",
        printer:
          printer.Name,
      })
    } catch (error) {
      console.error(
        "Test print error:",
        error
      )

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Failed to send RAW test print.",
          error:
            error.message,
        })
    }
  }
)


// ============================================================
// PRINT ACTUAL SALE RECEIPT
// ============================================================

app.post(
  "/print-receipt",
  async (
    req,
    res
  ) => {
    try {
      const sale =
        req.body?.sale

      // --------------------------------------------------------
      // CHECK SALE
      // --------------------------------------------------------

      if (!sale) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Sale data is required.",
          })
      }

      // --------------------------------------------------------
      // GET PRINTER
      // --------------------------------------------------------

      const printer =
        await getDefaultPrinter()

      if (!printer) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "No default printer found.",
          })
      }

      // --------------------------------------------------------
      // CHECK OFFLINE
      // --------------------------------------------------------

      if (
        printer.WorkOffline ===
        true
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              `Printer "${printer.Name}" is offline.`,
          })
      }

      // --------------------------------------------------------
      // LOG
      // --------------------------------------------------------

      console.log("")
      console.log(
        "======================================"
      )
      console.log(
        "PRINT POS RECEIPT"
      )
      console.log(
        "======================================"
      )

      console.log(
        "Printer:",
        printer.Name
      )

      console.log(
        "Invoice:",
        sale?.invoice ??
          sale?.invoice_number ??
          "-"
      )

      console.log(
        "Customer:",
        sale?.customer_name ??
          "Walk-in Customer"
      )

      console.log(
        "Payment:",
        sale?.payment_method ??
          "Cash"
      )

      console.log(
        "Total:",
        sale?.total_amount ??
          sale?.total ??
          0
      )

      console.log(
        "Items:",
        Array.isArray(
          sale?.sale_items
        )
          ? sale.sale_items.length
          : 0
      )

      console.log(
        "======================================"
      )

      // --------------------------------------------------------
      // CREATE RECEIPT
      // --------------------------------------------------------

      const receipt =
        createSaleReceipt(
          sale
        )

      // --------------------------------------------------------
      // PRINT
      // --------------------------------------------------------

      await rawPrint(
        printer.Name,
        receipt
      )

      console.log(
        "Receipt printed successfully."
      )

      return res.json({
        success: true,
        message:
          "Receipt printed successfully.",
        printer:
          printer.Name,
      })
    } catch (error) {
      console.error("")
      console.error(
        "======================================"
      )
      console.error(
        "RECEIPT PRINT FAILED"
      )
      console.error(
        "======================================"
      )
      console.error(
        error
      )
      console.error(
        "======================================"
      )

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Failed to print receipt.",
          error:
            error.message,
        })
    }
  }
)


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  HOST,
  () => {
    console.log("")
    console.log(
      "======================================"
    )
    console.log(
      "       ELKJ POS PRINT SERVICE"
    )
    console.log(
      "======================================"
    )
    console.log(
      `Service: http://${HOST}:${PORT}`
    )
    console.log(
      `Printer: http://${HOST}:${PORT}/printer`
    )
    console.log(
      `Test:    POST http://${HOST}:${PORT}/print-test`
    )
    console.log(
      `Receipt: POST http://${HOST}:${PORT}/print-receipt`
    )
    console.log(
      "======================================"
    )
    console.log("")
  }
)
