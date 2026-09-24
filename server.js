const express = require("express")
const cors = require("cors")
const { execFile } = require("child_process")

const app = express()

// =====================================================
// CONFIG
// =====================================================

const PORT = 9100
const HOST = "127.0.0.1"

const RENDER_API =
  process.env.RENDER_API ||
  "https://printing-service-a55f.onrender.com"

const PRINT_API_KEY =
  process.env.PRINT_API_KEY ||
  "ELKJ_PRINT_2026_SECRET"

// Poll every 2 seconds
const POLL_INTERVAL = 2000

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(
  cors({
    origin: "*",
  })
)

app.use(express.json({ limit: "2mb" }))

// =====================================================
// POWERSELL HELPER
// =====================================================

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr?.trim() ||
                stdout?.trim() ||
                error.message
            )
          )

          return
        }

        resolve(stdout.trim())
      }
    )
  })
}

// =====================================================
// GET DEFAULT PRINTER
// =====================================================

async function getDefaultPrinter() {
  const script = `
    Get-CimInstance Win32_Printer |
    Where-Object { $_.Default -eq $true } |
    Select-Object Name, PrinterStatus, Default, WorkOffline, PrinterState |
    ConvertTo-Json -Compress
  `

  const output = await runPowerShell(script)

  if (!output) {
    return null
  }

  let printer

  try {
    printer = JSON.parse(output)
  } catch {
    throw new Error("Unable to parse printer information.")
  }

  if (Array.isArray(printer)) {
    printer = printer[0]
  }

  return printer || null
}

// =====================================================
// RAW PRINTER
// =====================================================

async function rawPrint(printerName, receiptText) {
  const base64 = Buffer.from(receiptText, "ascii").toString(
    "base64"
  )

  const escapedPrinterName = printerName.replace(/'/g, "''")

  const script = `
$printerName = '${escapedPrinterName}'

$base64 = '${base64}'

$bytes = [System.Convert]::FromBase64String($base64)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class RawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO
    {
        [MarshalAs(UnmanagedType.LPWStr)]
        public string pDocName;

        [MarshalAs(UnmanagedType.LPWStr)]
        public string pOutputFile;

        [MarshalAs(UnmanagedType.LPWStr)]
        public string pDataType;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool OpenPrinter(
        string pPrinterName,
        out IntPtr phPrinter,
        IntPtr pDefault
    );

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(
        IntPtr hPrinter
    );

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool StartDocPrinter(
        IntPtr hPrinter,
        int level,
        DOCINFO pDocInfo
    );

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(
        IntPtr hPrinter
    );

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(
        IntPtr hPrinter
    );

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(
        IntPtr hPrinter
    );

    [DllImport("winspool.drv", SetLastError = true)]
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
        IntPtr hPrinter;

        if (!OpenPrinter(
            printerName,
            out hPrinter,
            IntPtr.Zero
        ))
        {
            throw new Exception(
                "OpenPrinter failed. Error: " +
                Marshal.GetLastWin32Error()
            );
        }

        try
        {
            DOCINFO docInfo = new DOCINFO();

            docInfo.pDocName = "ELKJ POS Receipt";
            docInfo.pDataType = "RAW";

            if (!StartDocPrinter(
                hPrinter,
                1,
                docInfo
            ))
            {
                throw new Exception(
                    "StartDocPrinter failed. Error: " +
                    Marshal.GetLastWin32Error()
                );
            }

            try
            {
                if (!StartPagePrinter(hPrinter))
                {
                    throw new Exception(
                        "StartPagePrinter failed. Error: " +
                        Marshal.GetLastWin32Error()
                    );
                }

                try
                {
                    IntPtr unmanagedPointer =
                        Marshal.AllocHGlobal(bytes.Length);

                    try
                    {
                        Marshal.Copy(
                            bytes,
                            0,
                            unmanagedPointer,
                            bytes.Length
                        );

                        int written;

                        if (!WritePrinter(
                            hPrinter,
                            unmanagedPointer,
                            bytes.Length,
                            out written
                        ))
                        {
                            throw new Exception(
                                "WritePrinter failed. Error: " +
                                Marshal.GetLastWin32Error()
                            );
                        }

                        if (written != bytes.Length)
                        {
                            throw new Exception(
                                "Only " +
                                written +
                                " of " +
                                bytes.length +
                                " bytes were written."
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
                    EndPagePrinter(hPrinter);
                }
            }
            finally
            {
                EndDocPrinter(hPrinter);
            }
        }
        finally
        {
            ClosePrinter(hPrinter);
        }
    }
}
"@

[RawPrinter]::SendBytes(
    $printerName,
    $bytes
)

Write-Output "PRINT_SUCCESS"
`

  const output = await runPowerShell(script)

  if (!output.includes("PRINT_SUCCESS")) {
    throw new Error(
      output || "Unknown printer error."
    )
  }

  return true
}

// =====================================================
// RECEIPT HELPERS
// =====================================================

function line(char = "-", length = 32) {
  return char.repeat(length)
}

function padRight(text, length) {
  text = String(text ?? "")

  if (text.length >= length) {
    return text.substring(0, length)
  }

  return text + " ".repeat(length - text.length)
}

function padLeft(text, length) {
  text = String(text ?? "")

  if (text.length >= length) {
    return text.substring(0, length)
  }

  return " ".repeat(length - text.length) + text
}

function money(value) {
  const number = Number(value || 0)

  return number.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function twoColumns(left, right, width = 32) {
  const rightText = String(right)

  const leftWidth = width - rightText.length - 1

  if (leftWidth <= 0) {
    return rightText.substring(0, width)
  }

  return (
    padRight(left, leftWidth) +
    " " +
    padLeft(rightText, rightText.length)
  )
}

// =====================================================
// CREATE SALE RECEIPT
// =====================================================

function createSaleReceipt(sale) {
  const WIDTH = 32

  let receipt = ""

  // ===================================================
  // HEADER
  // ===================================================

  receipt += "\x1B\x40"

  receipt += "\x1B\x61\x01"
  receipt += "\x1B\x45\x01"

  receipt += "ELKJ IT SOLUTIONS\n"

  receipt += "\x1B\x45\x00"

  receipt += "POINT OF SALE SYSTEM\n"

  receipt += "\x1B\x61\x00"

  receipt += line("=", WIDTH) + "\n"

  // ===================================================
  // SALE INFO
  // ===================================================

  receipt += `Invoice: ${sale.invoice_number || sale.invoice || "-"}\n`

  if (sale.customer_name) {
    receipt += `Customer: ${sale.customer_name}\n`
  }

  if (sale.customer_contact) {
    receipt += `Contact: ${sale.customer_contact}\n`
  }

  if (sale.created_at) {
    const date = new Date(sale.created_at)

    if (!Number.isNaN(date.getTime())) {
      receipt += `Date: ${date.toLocaleString("en-PH")}\n`
    }
  }

  receipt += line("-", WIDTH) + "\n"

  // ===================================================
  // ITEMS
  // ===================================================

  const items =
    sale.items ||
    sale.sale_items ||
    sale.saleItems ||
    []

  for (const item of items) {
    const productName =
      item.product_name ||
      item.name ||
      item.product?.name ||
      "Product"

    const quantity =
      Number(
        item.quantity ||
          item.qty ||
          0
      )

    const price =
      Number(
        item.unit_price ||
          item.price ||
          item.product?.selling_price ||
          0
      )

    const total =
      Number(
        item.total ||
          item.subtotal ||
          quantity * price
      )

    receipt += `${productName}\n`

    receipt +=
      `${quantity} x ${money(price)}` +
      padLeft(
        money(total),
        Math.max(
          1,
          WIDTH -
            (`${quantity} x ${money(price)}`).length
        )
      ) +
      "\n"
  }

  receipt += line("-", WIDTH) + "\n"

  // ===================================================
  // TOTALS
  // ===================================================

  const subtotal = Number(
    sale.subtotal ||
      sale.sub_total ||
      0
  )

  const discount = Number(
    sale.discount ||
      0
  )

  const tax = Number(
    sale.tax ||
      0
  )

  const total = Number(
    sale.total ||
      sale.total_amount ||
      0
  )

  receipt += twoColumns(
    "Subtotal",
    money(subtotal),
    WIDTH
  ) + "\n"

  if (discount > 0) {
    receipt += twoColumns(
      "Discount",
      `-${money(discount)}`,
      WIDTH
    ) + "\n"
  }

  if (tax > 0) {
    receipt += twoColumns(
      "Tax",
      money(tax),
      WIDTH
    ) + "\n"
  }

  receipt += line("-", WIDTH) + "\n"

  receipt += "\x1B\x45\x01"

  receipt += twoColumns(
    "TOTAL",
    money(total),
    WIDTH
  ) + "\n"

  receipt += "\x1B\x45\x00"

  receipt += line("-", WIDTH) + "\n"

  // ===================================================
  // PAYMENT
  // ===================================================

  if (sale.payment_method) {
    receipt += `Payment: ${sale.payment_method}\n`
  }

  if (sale.payment_provider) {
    receipt += `Provider: ${sale.payment_provider}\n`
  }

  if (sale.provider) {
    receipt += `Provider: ${sale.provider}\n`
  }

  if (sale.reference) {
    receipt += `Reference: ${sale.reference}\n`
  }

  if (sale.reference_number) {
    receipt += `Reference: ${sale.reference_number}\n`
  }

  const amountPaid = Number(
    sale.amount_paid ||
      sale.paid_amount ||
      0
  )

  if (amountPaid > 0) {
    receipt += twoColumns(
      "Amount Paid",
      money(amountPaid),
      WIDTH
    ) + "\n"
  }

  const change = Number(
    sale.change ||
      sale.change_amount ||
      0
  )

  if (change > 0) {
    receipt += twoColumns(
      "Change",
      money(change),
      WIDTH
    ) + "\n"
  }

  // ===================================================
  // INSTALLMENT
  // ===================================================

  if (sale.installment) {
    receipt += line("-", WIDTH) + "\n"

    receipt += "INSTALLMENT\n"

    if (sale.installment.term) {
      receipt += `Term: ${sale.installment.term} months\n`
    }

    if (sale.installment.down_payment) {
      receipt +=
        `Down Payment: ${money(
          sale.installment.down_payment
        )}\n`
    }

    if (sale.installment.installment_amount) {
      receipt +=
        `Monthly: ${money(
          sale.installment.installment_amount
        )}\n`
    }
  }

  // ===================================================
  // FOOTER
  // ===================================================

  receipt += "\n"

  receipt += "\x1B\x61\x01"

  receipt += "Thank you for your purchase!\n"
  receipt += "Please keep this receipt.\n"

  receipt += "\x1B\x61\x00"

  receipt += "\n\n\n"

  // ESC/POS CUT
  receipt += "\x1D\x56\x00"

  return receipt
}

// =====================================================
// PRINT JOB
// =====================================================

async function processPrintJob(job) {
  if (!job || !job.sale) {
    throw new Error("Invalid print job.")
  }

  let printerName = job.printer_name

  // If no printer specified, use Windows default printer
  if (!printerName) {
    const printer = await getDefaultPrinter()

    if (!printer) {
      throw new Error(
        "No default Windows printer found."
      )
    }

    printerName = printer.Name

    if (printer.WorkOffline === true) {
      throw new Error(
        `Printer "${printer.Name}" is offline.`
      )
    }
  }

  console.log(
    `Printing job ${job.id} using "${printerName}"`
  )

  const receipt = createSaleReceipt(job.sale)

  await rawPrint(
    printerName,
    receipt
  )

  return {
    printerName,
  }
}

// =====================================================
// LOCAL HEALTH
// =====================================================

app.get("/", async (req, res) => {
  let printer = null
  let printerError = null

  try {
    printer = await getDefaultPrinter()
  } catch (error) {
    printerError = error.message
  }

  res.json({
    success: true,
    service: "ELKJ Windows Print Agent",
    status: "online",
    render_api: RENDER_API,
    printer,
    printer_error: printerError,
    time: new Date().toISOString(),
  })
})

// =====================================================
// PRINTER INFO
// =====================================================

app.get("/printer", async (req, res) => {
  try {
    const printer = await getDefaultPrinter()

    if (!printer) {
      return res.status(404).json({
        success: false,
        message: "No default printer found.",
      })
    }

    return res.json({
      success: true,
      printer,
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    })
  }
})

// =====================================================
// LOCAL PRINT TEST
// =====================================================

app.post("/print-test", async (req, res) => {
  try {
    const printer = await getDefaultPrinter()

    if (!printer) {
      return res.status(404).json({
        success: false,
        message: "No default printer found.",
      })
    }

    if (printer.WorkOffline === true) {
      return res.status(400).json({
        success: false,
        message: `Printer "${printer.Name}" is offline.`,
      })
    }

    const testReceipt = [
      "\x1B\x40",
      "\x1B\x61\x01",
      "\x1B\x45\x01",
      "ELKJ IT SOLUTIONS\n",
      "\x1B\x45\x00",
      "PRINT TEST\n",
      "\x1B\x61\x00",
      "--------------------------------\n",
      "Printer is working.\n",
      `Printer: ${printer.Name}\n`,
      `Date: ${new Date().toLocaleString("en-PH")}\n`,
      "--------------------------------\n",
      "\n\n\n",
      "\x1D\x56\x00",
    ].join("")

    await rawPrint(
      printer.Name,
      testReceipt
    )

    res.json({
      success: true,
      message: "Test receipt printed.",
      printer: printer.Name,
    })
  } catch (error) {
    console.error("Print test error:", error)

    res.status(500).json({
      success: false,
      message: error.message,
    })
  }
})

// =====================================================
// MANUAL LOCAL PRINT
// =====================================================

app.post("/print-receipt", async (req, res) => {
  try {
    const { sale, printer_name } = req.body

    if (!sale) {
      return res.status(422).json({
        success: false,
        message: "sale is required.",
      })
    }

    const job = {
      id: "local",
      printer_name:
        printer_name || null,
      sale,
    }

    const result =
      await processPrintJob(job)

    return res.json({
      success: true,
      message: "Receipt printed.",
      printer: result.printerName,
    })
  } catch (error) {
    console.error(
      "Local receipt error:",
      error
    )

    return res.status(500).json({
      success: false,
      message: error.message,
    })
  }
})

// =====================================================
// RENDER API REQUEST HELPER
// =====================================================

async function renderRequest(
  endpoint,
  options = {}
) {
  const response = await fetch(
    `${RENDER_API}${endpoint}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Print-Api-Key": PRINT_API_KEY,
        ...(options.headers || {}),
      },
    }
  )

  const text = await response.text()

  let data

  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(
      `Render returned invalid JSON: ${text}`
    )
  }

  if (!response.ok) {
    throw new Error(
      data.message ||
        `Render request failed: ${response.status}`
    )
  }

  return data
}

// =====================================================
// POLL RENDER FOR PRINT JOB
// =====================================================

let isProcessing = false

async function pollPrintJobs() {
  if (isProcessing) {
    return
  }

  isProcessing = true

  try {
    const result =
      await renderRequest(
        "/print-job/next"
      )

    const job = result.job

    if (!job) {
      return
    }

    console.log(
      `Received print job: ${job.id}`
    )

    try {
      const printResult =
        await processPrintJob(job)

      await renderRequest(
        `/print-job/${job.id}/complete`,
        {
          method: "POST",
          body: JSON.stringify({
            printer: printResult.printerName,
          }),
        }
      )

      console.log(
        `Print job completed: ${job.id}`
      )
    } catch (printError) {
      console.error(
        `Print failed: ${job.id}`,
        printError
      )

      await renderRequest(
        `/print-job/${job.id}/fail`,
        {
          method: "POST",
          body: JSON.stringify({
            error: printError.message,
          }),
        }
      )
    }
  } catch (error) {
    console.error(
      "Polling error:",
      error.message
    )
  } finally {
    isProcessing = false
  }
}

// =====================================================
// START POLLING
// =====================================================

setInterval(
  pollPrintJobs,
  POLL_INTERVAL
)

// Run immediately
pollPrintJobs()

// =====================================================
// START LOCAL SERVER
// =====================================================

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      "=========================================="
    )

    console.log(
      "ELKJ WINDOWS PRINT AGENT"
    )

    console.log(
      "=========================================="
    )

    console.log(
      `Local URL: http://${HOST}:${PORT}`
    )

    console.log(
      `Render API: ${RENDER_API}`
    )

    console.log(
      `Polling every ${POLL_INTERVAL}ms`
    )

    console.log(
      "=========================================="
    )
  }
)
