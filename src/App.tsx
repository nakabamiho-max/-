import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import { Upload, FileText, Download, Loader2, Trash2, Plus, AlertCircle, Image as ImageIcon, Wallet, FolderOpen, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import Encoding from 'encoding-japanese';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface Account {
  id: string;
  name: string;
}

interface JournalEntry {
  id: string;
  accountId: string;
  no: number;
  date: string;
  debitAccount: string;
  debitAmount: number | null;
  debitTax: string;
  creditAccount: string;
  creditAmount: number | null;
  creditTax: string;
  description: string;
}

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([
    { id: 'default', name: 'メイン事業口座' }
  ]);
  const [activeAccountId, setActiveAccountId] = useState<string>('default');
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [progressMessage, setProgressMessage] = useState<string>('');
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [showAddAccountModal, setShowAddAccountModal] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeAccount = accounts.find(a => a.id === activeAccountId);
  const activeEntries = entries.filter(e => e.accountId === activeAccountId).sort((a, b) => a.no - b.no);

  const handleAddAccountClick = () => {
    setNewAccountName('');
    setShowAddAccountModal(true);
  };

  const confirmAddAccount = () => {
    if (newAccountName.trim()) {
      const newAccount = { id: Math.random().toString(36).substring(7), name: newAccountName.trim() };
      setAccounts([...accounts, newAccount]);
      setActiveAccountId(newAccount.id);
      setShowAddAccountModal(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      await processFiles(files);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (files.length > 0) {
      await processFiles(files);
    }
  }, [activeAccountId, entries]);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const cancelExtraction = () => {
    if (abortController) {
      abortController.abort();
      setIsExtracting(false);
      setProgressMessage('処理を中止しました。');
      setAbortController(null);
    }
  };

  const convertPdfToImages = async (file: File): Promise<string[]> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const images: string[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      setProgressMessage(`PDFを画像に変換中... (${i}/${pdf.numPages}ページ)`);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 }); // Higher scale for better OCR
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) continue;

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({ canvasContext: context, viewport: viewport }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      images.push(dataUrl.split(',')[1]); // Just the base64 part
    }
    return images;
  };

  const processFiles = async (files: File[]) => {
    setIsExtracting(true);
    setError(null);
    setProgressMessage('処理を開始しています...');
    
    const controller = new AbortController();
    setAbortController(controller);

    try {
      let newEntries: JournalEntry[] = [];
      let currentMaxNo = entries.filter(e => e.accountId === activeAccountId).reduce((max, e) => Math.max(max, e.no), 0);

      let totalImagesToProcess = 0;
      let processedImagesCount = 0;
      
      // First, count total images (including PDF pages)
      const fileDataList: { base64: string, mimeType: string, name: string }[] = [];
      
      for (const file of files) {
        if (controller.signal.aborted) throw new Error('Aborted');
        
        if (file.type === 'application/pdf') {
          setProgressMessage(`PDFを読み込み中: ${file.name}`);
          const pdfImages = await convertPdfToImages(file);
          pdfImages.forEach((base64, index) => {
            fileDataList.push({ base64, mimeType: 'image/jpeg', name: `${file.name} (P.${index + 1})` });
          });
        } else if (file.type.startsWith('image/')) {
          const base64Data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const result = reader.result as string;
              resolve(result.split(',')[1]);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          fileDataList.push({ base64: base64Data, mimeType: file.type, name: file.name });
        }
      }

      totalImagesToProcess = fileDataList.length;

      for (const fileData of fileDataList) {
        if (controller.signal.aborted) throw new Error('Aborted');
        
        processedImagesCount++;
        setProgressMessage(`AIでデータを抽出中... (${processedImagesCount}/${totalImagesToProcess}) - ${fileData.name}`);

        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: [
            {
              inlineData: {
                data: fileData.base64,
                mimeType: fileData.mimeType,
              },
            },
            {
              text: `
                この画像は銀行の通帳の写真です。
                以下の情報を抽出し、弥生会計の仕訳データ形式に変換してJSON配列として出力してください。
                
                【仕訳のルール】
                - この通帳の勘定科目は「普通預金」とします。
                - 引出（支払い）の場合：貸方勘定科目は「普通預金」、借方勘定科目は摘要から推測してください（例：通信費、消耗品費、水道光熱費、支払手数料など）。
                - 預入（受け取り）の場合：借方勘定科目は「普通預金」、貸方勘定科目は摘要から推測してください（例：売上高、売掛金など）。
                - 税区分：一般的な消費税のルールに従って推測してください（例：対象外、課税仕入10%、課税売上10%など）。不明な場合は「対象外」としてください。
                - 金額のカンマは除外して数値として出力してください。
                
                【出力JSONのプロパティ】
                - date: 取引日 (YYYY/MM/DD)
                - debitAccount: 借方勘定科目
                - debitAmount: 借方金額 (数値、ない場合はnull)
                - debitTax: 借方税区分
                - creditAccount: 貸方勘定科目
                - creditAmount: 貸方金額 (数値、ない場合はnull)
                - creditTax: 貸方税区分
                - description: 摘要
              `,
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  date: { type: Type.STRING, description: 'YYYY/MM/DD' },
                  debitAccount: { type: Type.STRING },
                  debitAmount: { type: Type.NUMBER, nullable: true },
                  debitTax: { type: Type.STRING },
                  creditAccount: { type: Type.STRING },
                  creditAmount: { type: Type.NUMBER, nullable: true },
                  creditTax: { type: Type.STRING },
                  description: { type: Type.STRING },
                },
                required: ['date', 'description', 'debitAccount', 'creditAccount'],
              },
            },
          },
        });

        if (controller.signal.aborted) throw new Error('Aborted');

        const jsonStr = response.text?.trim() || '[]';
        const parsedData = JSON.parse(jsonStr);
        
        const formattedData: JournalEntry[] = parsedData.map((item: any, index: number) => ({
          id: Math.random().toString(36).substring(7),
          accountId: activeAccountId,
          no: currentMaxNo + index + 1,
          date: item.date || '',
          debitAccount: item.debitAccount || '',
          debitAmount: item.debitAmount ?? null,
          debitTax: item.debitTax || '対象外',
          creditAccount: item.creditAccount || '',
          creditAmount: item.creditAmount ?? null,
          creditTax: item.creditTax || '対象外',
          description: item.description || '',
        }));

        currentMaxNo += formattedData.length;
        newEntries = [...newEntries, ...formattedData];
      }

      setEntries(prev => [...prev, ...newEntries]);
      setProgressMessage('処理が完了しました。');
    } catch (err: any) {
      if (err.message === 'Aborted') {
        console.log('Extraction aborted by user');
      } else {
        console.error('Extraction error:', err);
        setError('データの抽出に失敗しました。画像が不鮮明か、APIエラーの可能性があります。');
      }
    } finally {
      if (!abortController?.signal.aborted) {
        setIsExtracting(false);
        setAbortController(null);
      }
    }
  };

  const handleEntryChange = (id: string, field: keyof JournalEntry, value: string) => {
    setEntries(prev => prev.map(e => {
      if (e.id === id) {
        if (field === 'debitAmount' || field === 'creditAmount' || field === 'no') {
          const numValue = value === '' ? null : Number(value);
          return { ...e, [field]: isNaN(numValue as number) ? null : numValue };
        }
        return { ...e, [field]: value };
      }
      return e;
    }));
  };

  const addRow = () => {
    const currentMaxNo = activeEntries.reduce((max, e) => Math.max(max, e.no), 0);
    setEntries([
      ...entries,
      {
        id: Math.random().toString(36).substring(7),
        accountId: activeAccountId,
        no: currentMaxNo + 1,
        date: '',
        debitAccount: '',
        debitAmount: null,
        debitTax: '対象外',
        creditAccount: '',
        creditAmount: null,
        creditTax: '対象外',
        description: '',
      }
    ]);
  };

  const removeRow = (id: string) => {
    setEntries(entries.filter(e => e.id !== id));
  };

  const handleClearAllClick = () => {
    if (activeEntries.length === 0) return;
    setShowDeleteConfirmModal(true);
  };

  const confirmClearAll = () => {
    setEntries(entries.filter(e => e.accountId !== activeAccountId));
    setShowDeleteConfirmModal(false);
  };

  const exportCSV = () => {
    if (activeEntries.length === 0) return;

    const headers = ['No.', '取引日', '借方勘定科目', '借方金額', '借方税区分', '貸方勘定科目', '貸方金額', '貸方税区分', '摘要'];
    
    const rows = activeEntries.map(e => [
      e.no.toString(),
      e.date,
      `"${e.debitAccount}"`,
      e.debitAmount !== null ? e.debitAmount.toString() : '',
      `"${e.debitTax}"`,
      `"${e.creditAccount}"`,
      e.creditAmount !== null ? e.creditAmount.toString() : '',
      `"${e.creditTax}"`,
      `"${e.description.replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');

    try {
      const unicodeArray = Encoding.stringToCode(csvContent);
      const sjisArray = Encoding.convert(unicodeArray, {
        to: 'SJIS',
        from: 'UNICODE'
      });

      const blob = new Blob([new Uint8Array(sjisArray)], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `yayoi_journal_${activeAccount?.name}_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('CSV export error (Shift_JIS):', err);
      // Fallback to UTF-8 with BOM
      try {
        const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
        const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `yayoi_journal_${activeAccount?.name}_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (fallbackErr) {
        console.error('CSV fallback export error:', fallbackErr);
        alert('CSVの生成に失敗しました。');
      }
    }
  };

  return (
    <div className="flex h-screen bg-neutral-50 text-neutral-900 font-sans overflow-hidden">
      
      {/* Sidebar */}
      <aside className={`bg-white border-r border-neutral-200 flex flex-col z-20 transition-all duration-300 ${isSidebarOpen ? 'w-64' : 'w-16'}`}>
        <div className="p-4 border-b border-neutral-200 flex items-center gap-2">
          <div className="bg-emerald-600 p-1.5 rounded-md shrink-0">
            <Wallet className="w-5 h-5 text-white" />
          </div>
          {isSidebarOpen && (
            <h1 className="font-semibold tracking-tight text-neutral-900 truncate">
              弥生 通帳スキャナー
            </h1>
          )}
        </div>
        
        <div className="p-4 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            {isSidebarOpen && <h2 className="text-xs font-bold text-neutral-400 uppercase tracking-wider">口座一覧</h2>}
            <button 
              onClick={handleAddAccountClick}
              className={`p-1 text-neutral-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-colors ${!isSidebarOpen && 'mx-auto'}`}
              title="口座を追加"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          
          <ul className="space-y-1">
            {accounts.map(account => (
              <li key={account.id}>
                <button
                  onClick={() => setActiveAccountId(account.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                    activeAccountId === account.id 
                      ? 'bg-emerald-50 text-emerald-700 font-medium' 
                      : 'text-neutral-600 hover:bg-neutral-100'
                  } ${!isSidebarOpen && 'justify-center px-0'}`}
                  title={!isSidebarOpen ? account.name : undefined}
                >
                  <FolderOpen className={`w-4 h-4 shrink-0 ${activeAccountId === account.id ? 'text-emerald-600' : 'text-neutral-400'}`} />
                  {isSidebarOpen && <span className="truncate">{account.name}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
        
        <div className="p-2 border-t border-neutral-200">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="w-full flex items-center justify-center p-2 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors"
          >
            {isSidebarOpen ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b border-neutral-200 h-16 flex items-center justify-between px-6 shrink-0">
          <h2 className="text-lg font-medium flex items-center gap-2">
            {activeAccount?.name}
          </h2>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-full mx-auto space-y-6">
            
            {/* Upload Area */}
            <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-6">
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onClick={() => fileInputRef.current?.click()}
                className={`
                  border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
                  ${isExtracting ? 'border-neutral-200 bg-neutral-50' : 'border-emerald-200 bg-emerald-50 hover:bg-emerald-100'}
                `}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                />
                
                {isExtracting ? (
                  <div className="space-y-4 py-4">
                    <Loader2 className="w-8 h-8 animate-spin text-emerald-600 mx-auto" />
                    <div>
                      <p className="text-sm font-medium text-neutral-900">{progressMessage}</p>
                      <p className="text-xs text-neutral-500 mt-1">摘要から勘定科目を自動推測しています</p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelExtraction();
                      }}
                      className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-white border border-neutral-200 hover:bg-red-50 hover:text-red-600 hover:border-red-200 text-neutral-600 text-sm font-medium rounded-lg transition-colors"
                    >
                      <XCircle className="w-4 h-4" />
                      処理を中止
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="mx-auto w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center">
                      <Upload className="w-6 h-6 text-emerald-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-neutral-900">通帳の画像またはPDFを選択するか、ドラッグ＆ドロップ</p>
                      <p className="text-xs text-neutral-500 mt-1">複数ファイルの同時アップロードに対応しています (PNG, JPG, PDF)</p>
                    </div>
                  </div>
                )}
              </div>

              {error && (
                <div className="mt-4 p-4 bg-red-50 text-red-700 rounded-xl flex items-start gap-3 text-sm">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <p>{error}</p>
                </div>
              )}
            </div>

            {/* Data Table Section */}
            <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden flex flex-col">
              {/* Toolbar */}
              <div className="p-4 border-b border-neutral-200 bg-neutral-50/50 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <h3 className="font-medium text-neutral-900">仕訳データ</h3>
                  <span className="text-sm font-normal text-neutral-500 bg-neutral-100 px-2 py-0.5 rounded-full">
                    {activeEntries.length} 件
                  </span>
                </div>
                
                <div className="flex items-center gap-2">
                  <button
                    onClick={addRow}
                    className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors border border-transparent hover:border-emerald-200"
                  >
                    <Plus className="w-4 h-4" />
                    行を追加
                  </button>
                  
                  {activeEntries.length > 0 && (
                    <>
                      <div className="w-px h-6 bg-neutral-300 mx-1"></div>
                      <button
                        onClick={handleClearAllClick}
                        className="flex items-center gap-2 px-3 py-2 bg-white border border-red-200 hover:bg-red-50 text-red-600 text-sm font-medium rounded-lg transition-colors shadow-sm"
                      >
                        <Trash2 className="w-4 h-4" />
                        一括削除
                      </button>
                      <button
                        onClick={exportCSV}
                        className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
                      >
                        <Download className="w-4 h-4" />
                        CSVダウンロード
                      </button>
                    </>
                  )}
                </div>
              </div>

              {activeEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-16 text-neutral-400">
                  <FileText className="w-12 h-12 mb-4 opacity-20" />
                  <p>画像からデータを抽出すると、ここに仕訳データが表示されます。</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left whitespace-nowrap">
                    <thead className="text-xs text-neutral-500 uppercase bg-neutral-50 border-b border-neutral-200">
                      <tr>
                        <th className="px-3 py-3 font-medium w-16 text-center">No.</th>
                        <th className="px-3 py-3 font-medium w-32">取引日</th>
                        <th className="px-3 py-3 font-medium w-40">借方勘定科目</th>
                        <th className="px-3 py-3 font-medium w-32 text-right">借方金額</th>
                        <th className="px-3 py-3 font-medium w-32">借方税区分</th>
                        <th className="px-3 py-3 font-medium w-40">貸方勘定科目</th>
                        <th className="px-3 py-3 font-medium w-32 text-right">貸方金額</th>
                        <th className="px-3 py-3 font-medium w-32">貸方税区分</th>
                        <th className="px-3 py-3 font-medium min-w-[200px]">摘要</th>
                        <th className="px-3 py-3 font-medium text-center w-12"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {activeEntries.map((e) => (
                        <tr key={e.id} className="hover:bg-neutral-50/50 transition-colors group">
                          <td className="p-1.5">
                            <input
                              type="number"
                              value={e.no}
                              onChange={(ev) => handleEntryChange(e.id, 'no', ev.target.value)}
                              className="w-full px-2 py-1.5 bg-transparent border border-transparent hover:border-neutral-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded transition-all text-center"
                            />
                          </td>
                          <td className="p-1.5">
                            <input
                              type="text"
                              value={e.date}
                              onChange={(ev) => handleEntryChange(e.id, 'date', ev.target.value)}
                              className="w-full px-2 py-1.5 bg-transparent border border-transparent hover:border-neutral-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded transition-all"
                              placeholder="YYYY/MM/DD"
                            />
                          </td>
                          <td className="p-1.5">
                            <input
                              type="text"
                              value={e.debitAccount}
                              onChange={(ev) => handleEntryChange(e.id, 'debitAccount', ev.target.value)}
                              className="w-full px-2 py-1.5 bg-transparent border border-transparent hover:border-neutral-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded transition-all font-medium text-emerald-700"
                              placeholder="借方科目"
                            />
                          </td>
                          <td className="p-1.5">
                            <input
                              type="number"
                              value={e.debitAmount !== null ? e.debitAmount : ''}
                              onChange={(ev) => handleEntryChange(e.id, 'debitAmount', ev.target.value)}
                              className="w-full px-2 py-1.5 bg-transparent border border-transparent hover:border-neutral-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded transition-all text-right font-mono"
                              placeholder="-"
                            />
                          </td>
                          <td className="p-1.5">
                            <input
                              type="text"
                              value={e.debitTax}
                              onChange={(ev) => handleEntryChange(e.id, 'debitTax', ev.target.value)}
                              className="w-full px-2 py-1.5 bg-transparent border border-transparent hover:border-neutral-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded transition-all text-neutral-500 text-xs"
                              placeholder="税区分"
                            />
                          </td>
                          <td className="p-1.5">
                            <input
                              type="text"
                              value={e.creditAccount}
                              onChange={(ev) => handleEntryChange(e.id, 'creditAccount', ev.target.value)}
                              className="w-full px-2 py-1.5 bg-transparent border border-transparent hover:border-neutral-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded transition-all font-medium text-emerald-700"
                              placeholder="貸方科目"
                            />
                          </td>
                          <td className="p-1.5">
                            <input
                              type="number"
                              value={e.creditAmount !== null ? e.creditAmount : ''}
                              onChange={(ev) => handleEntryChange(e.id, 'creditAmount', ev.target.value)}
                              className="w-full px-2 py-1.5 bg-transparent border border-transparent hover:border-neutral-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded transition-all text-right font-mono"
                              placeholder="-"
                            />
                          </td>
                          <td className="p-1.5">
                            <input
                              type="text"
                              value={e.creditTax}
                              onChange={(ev) => handleEntryChange(e.id, 'creditTax', ev.target.value)}
                              className="w-full px-2 py-1.5 bg-transparent border border-transparent hover:border-neutral-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded transition-all text-neutral-500 text-xs"
                              placeholder="税区分"
                            />
                          </td>
                          <td className="p-1.5">
                            <input
                              type="text"
                              value={e.description}
                              onChange={(ev) => handleEntryChange(e.id, 'description', ev.target.value)}
                              className="w-full px-2 py-1.5 bg-transparent border border-transparent hover:border-neutral-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded transition-all"
                              placeholder="摘要"
                            />
                          </td>
                          <td className="p-1.5 text-center">
                            <button
                              onClick={() => removeRow(e.id)}
                              className="p-1.5 text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                              title="行を削除"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Add Account Modal */}
      {showAddAccountModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 relative">
            <h3 className="text-lg font-semibold text-neutral-900 mb-4">新しい口座を追加</h3>
            <input
              type="text"
              value={newAccountName}
              onChange={(e) => setNewAccountName(e.target.value)}
              placeholder="口座名を入力"
              className="w-full px-3 py-2 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-6"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmAddAccount();
              }}
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowAddAccountModal(false)}
                className="px-4 py-2 bg-white border border-neutral-200 hover:bg-neutral-50 text-neutral-700 text-sm font-medium rounded-lg transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={confirmAddAccount}
                disabled={!newAccountName.trim()}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 text-white text-sm font-medium rounded-lg transition-colors"
              >
                追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {showDeleteConfirmModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 relative">
            <div className="flex items-center gap-3 mb-4 text-red-600">
              <AlertCircle className="w-6 h-6" />
              <h3 className="text-lg font-semibold">一括削除の確認</h3>
            </div>
            <p className="text-neutral-600 mb-6">
              現在表示されている「{activeAccount?.name}」の仕訳データ {activeEntries.length} 件をすべて削除しますか？<br />
              この操作は取り消せません。
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDeleteConfirmModal(false)}
                className="px-4 py-2 bg-white border border-neutral-200 hover:bg-neutral-50 text-neutral-700 text-sm font-medium rounded-lg transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={confirmClearAll}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                削除する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
