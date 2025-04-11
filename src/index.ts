#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BigQuery } from '@google-cloud/bigquery';

import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';

// Define configuration interface
interface ServerConfig {
  projectId: string;
  location?: string;
  keyFilename?: string;
}

async function validateConfig(config: ServerConfig): Promise<void> {
  // Check if key file exists and is readable
  if (config.keyFilename) {
    const resolvedKeyPath = path.resolve(config.keyFilename);
    try {
      await fs.access(resolvedKeyPath, fsConstants.R_OK);
      // Update the config to use the resolved path
      config.keyFilename = resolvedKeyPath;
    } catch (error) {
      console.error('File access error details:', error);
      if (error instanceof Error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'EACCES') {
          throw new Error(`Permission denied accessing key file: ${resolvedKeyPath}. Please check file permissions.`);
        } else if (nodeError.code === 'ENOENT') {
          throw new Error(`Key file not found: ${resolvedKeyPath}. Please verify the file path.`);
        } else {
          throw new Error(`Unable to access key file: ${resolvedKeyPath}. Error: ${nodeError.message}`);
        }
      } else {
        throw new Error(`Unexpected error accessing key file: ${resolvedKeyPath}`);
      }
    }

    // Validate file contents
    try {
      const keyFileContent = await fs.readFile(config.keyFilename, 'utf-8');
      const keyData = JSON.parse(keyFileContent);
      
      // Basic validation of key file structure
      if (!keyData.type || keyData.type !== 'service_account' || !keyData.project_id) {
        throw new Error('Invalid service account key file format');
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Service account key file is not valid JSON');
      }
      throw error;
    }
  }

  // Validate project ID format (basic check)
  if (!/^[a-z0-9-]+$/.test(config.projectId)) {
    throw new Error('Invalid project ID format');
  }
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  const config: ServerConfig = {
    projectId: '',
    location: 'US' 
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Invalid argument: ${arg}`);
    }

    const key = arg.slice(2);
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
      throw new Error(`Missing value for argument: ${arg}`);
    }

    const value = args[++i];
    
    switch (key) {
      case 'project-id':
        config.projectId = value;
        break;
      case 'location':
        config.location = value;
        break;
      case 'key-file':
        config.keyFilename = value;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!config.projectId) {
    throw new Error(
      "Missing required argument: --project-id\n" +
      "Usage: mcp-server-bigquery --project-id <project-id> [--location <location>] [--key-file <path-to-key-file>]"
    );
  }

  return config;
}

const server = new Server(
  {
    name: "mcp-server/bigquery",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

let config: ServerConfig;
let bigquery: BigQuery;
let resourceBaseUrl: URL;

try {
  config = parseArgs();
  await validateConfig(config);
  
  console.error(`Initializing BigQuery with project ID: ${config.projectId} and location: ${config.location}`);
  
  const bigqueryConfig: {
    projectId: string;
    keyFilename?: string;
  } = {
    projectId: config.projectId
  };
  
  if (config.keyFilename) {
    console.error(`Using service account key file: ${config.keyFilename}`);
    bigqueryConfig.keyFilename = config.keyFilename;
  }
  
  bigquery = new BigQuery(bigqueryConfig);
  resourceBaseUrl = new URL(`bigquery://${config.projectId}`);
} catch (error) {
  console.error('Initialization error:', error);
  process.exit(1);
}

const SCHEMA_PATH = "schema";

function qualifyTablePath(sql: string, projectId: string): string {
  // Match FROM INFORMATION_SCHEMA.TABLES or FROM dataset.INFORMATION_SCHEMA.TABLES
  const unqualifiedPattern = /FROM\s+(?:(\w+)\.)?INFORMATION_SCHEMA\.TABLES/gi;
  return sql.replace(unqualifiedPattern, (match, dataset) => {
    if (dataset) {
      return `FROM \`${projectId}.${dataset}.INFORMATION_SCHEMA.TABLES\``;
    }
    throw new Error("Dataset must be specified when querying INFORMATION_SCHEMA (e.g. dataset.INFORMATION_SCHEMA.TABLES)");
  });
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    console.error('Fetching datasets...');
    const [datasets] = await bigquery.getDatasets();
    console.error(`Found ${datasets.length} datasets`);
    
    const resources = [];

    for (const dataset of datasets) {
      console.error(`Processing dataset: ${dataset.id}`);
      const [tables] = await dataset.getTables();
      console.error(`Found ${tables.length} tables and views in dataset ${dataset.id}`);
      
      for (const table of tables) {
        // Get the metadata to check if it's a table or view
        const [metadata] = await table.getMetadata();
        const resourceType = metadata.type === 'VIEW' ? 'view' : 'table';
        
        resources.push({
          uri: new URL(`${dataset.id}/${table.id}/${SCHEMA_PATH}`, resourceBaseUrl).href,
          mimeType: "application/json",
          name: `"${dataset.id}.${table.id}" ${resourceType} schema`,
        });
      }
    }

    console.error(`Total resources found: ${resources.length}`);
    return { resources };
  } catch (error) {
    console.error('Error in ListResourcesRequestSchema:', error);
    throw error;
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request: any) => {
  const resourceUrl = new URL(request.params.uri);
  const pathComponents = resourceUrl.pathname.split("/");
  const schema = pathComponents.pop();
  const tableId = pathComponents.pop();
  const datasetId = pathComponents.pop();

  if (schema !== SCHEMA_PATH) {
    throw new Error("Invalid resource URI");
  }

  const dataset = bigquery.dataset(datasetId!);
  const table = dataset.table(tableId!);
  const [metadata] = await table.getMetadata();

  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(metadata.schema.fields, null, 2),
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Run a read-only BigQuery SQL query",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string" },
            maximumBytesBilled: { 
              type: "string",
              description: "Maximum bytes billed (default: 1GB)",
              optional: true
            }
          },
        },
      },
      {
        name: "generate_sql",
        description: "Generate SQL from natural language query",
        inputSchema: {
          type: "object",
          properties: {
            question: { 
              type: "string",
              description: "Natural language question about the data"
            },
            context: { 
              type: "string",
              description: "Additional context about the data or specific requirements",
              optional: true
            }
          },
          required: ["question"]
        },
      },
      {
        name: "analyze_results",
        description: "Analyze and summarize query results",
        inputSchema: {
          type: "object",
          properties: {
            data: { 
              type: "string",
              description: "JSON string of query results to analyze"
            },
            focus: { 
              type: "string",
              description: "Specific aspect to focus analysis on (e.g., 'trends', 'outliers', 'distribution')",
              optional: true
            }
          },
          required: ["data"]
        },
      },
      {
        name: "generate_visualization",
        description: "Generate code for data visualization",
        inputSchema: {
          type: "object",
          properties: {
            data: { 
              type: "string",
              description: "JSON string of data to visualize"
            },
            type: { 
              type: "string",
              description: "Type of visualization (e.g., 'bar', 'line', 'scatter', 'pie')",
              optional: true
            },
            title: { 
              type: "string",
              description: "Title for the visualization",
              optional: true
            }
          },
          required: ["data"]
        },
      },
      {
        name: "get_schema_insights",
        description: "Get insights about database schema and relationships",
        inputSchema: {
          type: "object",
          properties: {
            dataset: { 
              type: "string",
              description: "Dataset to analyze",
              optional: true
            }
          }
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  if (request.params.name === "query") {
    let sql = request.params.arguments?.sql as string;
    let maximumBytesBilled = request.params.arguments?.maximumBytesBilled || "1000000000";
    
    // Validate read-only query
    const forbiddenPattern = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|MERGE|TRUNCATE|GRANT|REVOKE|EXECUTE|BEGIN|COMMIT|ROLLBACK)\b/i;
    if (forbiddenPattern.test(sql)) {
      throw new Error('Only READ operations are allowed');
    }    

    try {
      // Qualify INFORMATION_SCHEMA queries
      if (sql.toUpperCase().includes('INFORMATION_SCHEMA')) {
        sql = qualifyTablePath(sql, config.projectId);
      }

      const [rows] = await bigquery.query({
        query: sql,
        location: config.location,
        maximumBytesBilled: maximumBytesBilled.toString(),
      });

      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        isError: false,
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          content: [{ type: "text", text: `Error executing query: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  } 
  else if (request.params.name === "generate_sql") {
    const question = request.params.arguments?.question as string;
    const context = request.params.arguments?.context as string | undefined;
    
    try {
      // Get dataset and table information to provide context for SQL generation
      const [datasets] = await bigquery.getDatasets();
      const schemaInfo = [];
      
      // Limit to 5 datasets to avoid overwhelming the context
      const limitedDatasets = datasets.slice(0, 5);
      
      for (const dataset of limitedDatasets) {
        const [tables] = await dataset.getTables();
        
        for (const table of tables) {
          const [metadata] = await table.getMetadata();
          const resourceType = metadata.type === 'VIEW' ? 'view' : 'table';
          
          // Add basic schema information
          schemaInfo.push({
            name: `${dataset.id}.${table.id}`,
            type: resourceType,
            fields: metadata.schema?.fields?.map((f: any) => ({
              name: f.name,
              type: f.type
            })) || []
          });
        }
      }
      
      // Generate SQL based on the question and available schema information
      // This is a simplified approach - in a real implementation, you might use a more sophisticated method
      const schemaContext = JSON.stringify(schemaInfo, null, 2);
      let generatedSQL = "";
      
      // Simple SQL generation based on question patterns
      if (question.toLowerCase().includes("count") || question.toLowerCase().includes("how many")) {
        // For counting questions
        const targetTable = schemaInfo.length > 0 ? schemaInfo[0].name : "dataset.table";
        generatedSQL = `SELECT COUNT(*) as count FROM \`${targetTable}\``;
        
        // Add conditions if mentioned in the question
        if (question.toLowerCase().includes("where") || question.toLowerCase().includes("condition")) {
          generatedSQL += "\nWHERE -- Add conditions based on the question";
        }
      } 
      else if (question.toLowerCase().includes("average") || question.toLowerCase().includes("mean")) {
        // For average calculations
        const targetTable = schemaInfo.length > 0 ? schemaInfo[0].name : "dataset.table";
        const numericFields = schemaInfo.length > 0 ? 
          schemaInfo[0].fields.filter((f: any) => ["INTEGER", "FLOAT", "NUMERIC"].includes(f.type.toUpperCase())).map((f: any) => f.name) : 
          ["value_column"];
        
        const targetField = numericFields.length > 0 ? numericFields[0] : "value_column";
        generatedSQL = `SELECT AVG(${targetField}) as average FROM \`${targetTable}\``;
      }
      else if (question.toLowerCase().includes("top") || question.toLowerCase().includes("highest") || question.toLowerCase().includes("most")) {
        // For top N queries
        const targetTable = schemaInfo.length > 0 ? schemaInfo[0].name : "dataset.table";
        const fields = schemaInfo.length > 0 ? 
          schemaInfo[0].fields.map((f: any) => f.name).slice(0, 3) : 
          ["column1", "column2"];
        
        generatedSQL = `SELECT ${fields.join(", ")} FROM \`${targetTable}\`\nORDER BY -- relevant column DESC\nLIMIT 10`;
      }
      else {
        // Default select query
        const targetTable = schemaInfo.length > 0 ? schemaInfo[0].name : "dataset.table";
        const fields = schemaInfo.length > 0 ? 
          schemaInfo[0].fields.map((f: any) => f.name).slice(0, 5).join(", ") : 
          "*";
        
        generatedSQL = `SELECT ${fields} FROM \`${targetTable}\`\nLIMIT 100`;
      }
      
      // Add context information to help Claude refine the SQL
      const response = `
Based on your question: "${question}"
${context ? `\nAdditional context: ${context}` : ''}

Here's a suggested SQL query:
\`\`\`sql
${generatedSQL}
\`\`\`

Available schema information:
\`\`\`json
${schemaContext}
\`\`\`

This is a starting point. You may need to:
1. Select the appropriate table(s) based on your data
2. Adjust the columns in the SELECT clause
3. Add appropriate WHERE conditions
4. Modify ORDER BY, GROUP BY, or other clauses as needed
`;

      return {
        content: [{ type: "text", text: response }],
        isError: false,
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          content: [{ type: "text", text: `Error generating SQL: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  }
  else if (request.params.name === "analyze_results") {
    const dataString = request.params.arguments?.data as string;
    const focus = request.params.arguments?.focus as string | undefined;
    
    try {
      // Parse the JSON data
      const data = JSON.parse(dataString);
      
      if (!Array.isArray(data) || data.length === 0) {
        return {
          content: [{ type: "text", text: "The provided data is empty or not in the expected format (array of objects)." }],
          isError: true,
        };
      }
      
      // Basic data analysis
      const rowCount = data.length;
      const columns = Object.keys(data[0]);
      const columnTypes: Record<string, string> = {};
      const numericColumns: string[] = [];
      
      // Determine column types
      columns.forEach(col => {
        const sampleValue = data[0][col];
        if (typeof sampleValue === 'number') {
          columnTypes[col] = 'numeric';
          numericColumns.push(col);
        } else if (typeof sampleValue === 'string') {
          columnTypes[col] = 'string';
        } else if (typeof sampleValue === 'boolean') {
          columnTypes[col] = 'boolean';
        } else if (sampleValue instanceof Date) {
          columnTypes[col] = 'date';
        } else if (sampleValue === null) {
          columnTypes[col] = 'unknown';
        } else {
          columnTypes[col] = typeof sampleValue;
        }
      });
      
      // Calculate basic statistics for numeric columns
      const statistics: Record<string, any> = {};
      numericColumns.forEach(col => {
        const values = data.map(row => row[col]).filter(val => val !== null && !isNaN(val));
        if (values.length > 0) {
          const sum = values.reduce((a, b) => a + b, 0);
          const avg = sum / values.length;
          const min = Math.min(...values);
          const max = Math.max(...values);
          
          // Calculate median
          const sorted = [...values].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
          
          statistics[col] = {
            min,
            max,
            avg,
            median,
            sum
          };
        }
      });
      
      // Count distinct values for string columns (limit to first 5 columns for brevity)
      const categoricalAnalysis: Record<string, any> = {};
      columns.filter(col => columnTypes[col] === 'string').slice(0, 5).forEach(col => {
        const valueMap: Record<string, number> = {};
        data.forEach(row => {
          const val = row[col];
          if (val !== null && val !== undefined) {
            valueMap[val] = (valueMap[val] || 0) + 1;
          }
        });
        
        // Get top 5 most frequent values
        const topValues = Object.entries(valueMap)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([value, count]) => ({ value, count, percentage: (count / rowCount * 100).toFixed(2) + '%' }));
        
        categoricalAnalysis[col] = {
          distinctCount: Object.keys(valueMap).length,
          topValues
        };
      });
      
      // Generate insights based on the focus (if provided)
      let focusedInsights = "";
      if (focus) {
        if (focus.toLowerCase() === 'trends' && numericColumns.length > 0) {
          focusedInsights = "Trend Analysis:\n";
          numericColumns.forEach(col => {
            if (statistics[col]) {
              const range = statistics[col].max - statistics[col].min;
              focusedInsights += `- ${col}: Range of ${range.toFixed(2)} from ${statistics[col].min.toFixed(2)} to ${statistics[col].max.toFixed(2)}\n`;
            }
          });
        } 
        else if (focus.toLowerCase() === 'outliers' && numericColumns.length > 0) {
          focusedInsights = "Outlier Detection:\n";
          numericColumns.forEach(col => {
            if (statistics[col]) {
              const values = data.map(row => row[col]).filter(val => val !== null && !isNaN(val));
              const avg = statistics[col].avg;
              const stdDev = Math.sqrt(values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length);
              
              // Find potential outliers (values more than 2 standard deviations from the mean)
              const outliers = data.filter(row => {
                const val = row[col];
                return val !== null && !isNaN(val) && Math.abs(val - avg) > 2 * stdDev;
              });
              
              focusedInsights += `- ${col}: Found ${outliers.length} potential outliers (values outside 2 standard deviations from the mean)\n`;
            }
          });
        }
        else if (focus.toLowerCase() === 'distribution' && numericColumns.length > 0) {
          focusedInsights = "Distribution Analysis:\n";
          numericColumns.forEach(col => {
            if (statistics[col]) {
              // Create a simple histogram with 5 bins
              const values = data.map(row => row[col]).filter(val => val !== null && !isNaN(val));
              const min = statistics[col].min;
              const max = statistics[col].max;
              const range = max - min;
              const binSize = range / 5;
              
              const bins = Array(5).fill(0);
              values.forEach(val => {
                const binIndex = Math.min(Math.floor((val - min) / binSize), 4);
                bins[binIndex]++;
              });
              
              focusedInsights += `- ${col}: Distribution across 5 equal bins: [${bins.join(', ')}]\n`;
            }
          });
        }
      }
      
      // Compile the analysis
      const analysis = `
## Data Analysis Summary

**General Information:**
- Total rows: ${rowCount}
- Total columns: ${columns.length}

**Column Types:**
${Object.entries(columnTypes).map(([col, type]) => `- ${col}: ${type}`).join('\n')}

${numericColumns.length > 0 ? `
**Numeric Column Statistics:**
${Object.entries(statistics).map(([col, stats]) => `
### ${col}
- Minimum: ${stats.min.toFixed(2)}
- Maximum: ${stats.max.toFixed(2)}
- Average: ${stats.avg.toFixed(2)}
- Median: ${stats.median.toFixed(2)}
- Sum: ${stats.sum.toFixed(2)}
`).join('')}` : ''}

${Object.keys(categoricalAnalysis).length > 0 ? `
**Categorical Column Analysis:**
${Object.entries(categoricalAnalysis).map(([col, analysis]) => `
### ${col}
- Distinct values: ${analysis.distinctCount}
- Top values:
${analysis.topValues.map((v: any) => `  - "${v.value}": ${v.count} (${v.percentage})`).join('\n')}
`).join('')}` : ''}

${focusedInsights ? `
**Focused Analysis (${focus}):**
${focusedInsights}
` : ''}

**Key Insights:**
- ${rowCount > 1000 ? 'Large dataset with ' + rowCount + ' rows' : 'Small dataset with ' + rowCount + ' rows'}
${numericColumns.length > 0 ? `- Numeric columns show ${statistics[numericColumns[0]].max > statistics[numericColumns[0]].min * 10 ? 'wide' : 'narrow'} value ranges` : ''}
${Object.keys(categoricalAnalysis).length > 0 ? 
  `- The "${Object.keys(categoricalAnalysis)[0]}" column has ${categoricalAnalysis[Object.keys(categoricalAnalysis)[0]].distinctCount} distinct values` : ''}
`;

      return {
        content: [{ type: "text", text: analysis }],
        isError: false,
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          content: [{ type: "text", text: `Error analyzing data: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  }
  else if (request.params.name === "generate_visualization") {
    const dataString = request.params.arguments?.data as string;
    const visType = (request.params.arguments?.type as string || 'bar').toLowerCase();
    const title = request.params.arguments?.title as string || 'Data Visualization';
    
    try {
      // Parse the JSON data
      const data = JSON.parse(dataString);
      
      if (!Array.isArray(data) || data.length === 0) {
        return {
          content: [{ type: "text", text: "The provided data is empty or not in the expected format (array of objects)." }],
          isError: true,
        };
      }
      
      // Identify columns and their types
      const columns = Object.keys(data[0]);
      const columnTypes: Record<string, string> = {};
      
      columns.forEach(col => {
        const sampleValue = data[0][col];
        if (typeof sampleValue === 'number') {
          columnTypes[col] = 'numeric';
        } else if (typeof sampleValue === 'string') {
          columnTypes[col] = 'string';
        } else if (typeof sampleValue === 'boolean') {
          columnTypes[col] = 'boolean';
        } else if (sampleValue instanceof Date) {
          columnTypes[col] = 'date';
        } else {
          columnTypes[col] = typeof sampleValue;
        }
      });
      
      // Find suitable columns for visualization
      const numericColumns = columns.filter(col => columnTypes[col] === 'numeric');
      const categoricalColumns = columns.filter(col => columnTypes[col] === 'string' || columnTypes[col] === 'boolean');
      
      // Determine the best columns to use based on visualization type
      let xColumn = '';
      let yColumn = '';
      
      if (categoricalColumns.length > 0) {
        xColumn = categoricalColumns[0];
      } else if (numericColumns.length > 0) {
        xColumn = numericColumns[0];
      } else {
        xColumn = columns[0];
      }
      
      if (numericColumns.length > 0) {
        yColumn = numericColumns[0];
        if (xColumn === yColumn && numericColumns.length > 1) {
          yColumn = numericColumns[1];
        }
      } else {
        yColumn = columns[columns.length > 1 ? 1 : 0];
      }
      
      // Generate HTML with Chart.js visualization
      let chartType = 'bar'; // default
      
      switch (visType) {
        case 'bar':
          chartType = 'bar';
          break;
        case 'line':
          chartType = 'line';
          break;
        case 'pie':
          chartType = 'pie';
          break;
        case 'scatter':
          chartType = 'scatter';
          break;
        default:
          chartType = 'bar';
      }
      
      // Prepare data for the chart
      let chartData;
      let chartOptions;
      
      if (chartType === 'pie') {
        // For pie charts, we need to aggregate data if there are multiple instances of the same category
        const aggregatedData: Record<string, number> = {};
        
        data.forEach(row => {
          const key = String(row[xColumn]);
          if (numericColumns.length > 0) {
            aggregatedData[key] = (aggregatedData[key] || 0) + Number(row[yColumn]);
          } else {
            aggregatedData[key] = (aggregatedData[key] || 0) + 1;
          }
        });
        
        const labels = Object.keys(aggregatedData);
        const values = Object.values(aggregatedData);
        
        chartData = {
          labels,
          datasets: [{
            data: values,
            backgroundColor: [
              'rgba(255, 99, 132, 0.7)',
              'rgba(54, 162, 235, 0.7)',
              'rgba(255, 206, 86, 0.7)',
              'rgba(75, 192, 192, 0.7)',
              'rgba(153, 102, 255, 0.7)',
              'rgba(255, 159, 64, 0.7)',
              'rgba(199, 199, 199, 0.7)',
              'rgba(83, 102, 255, 0.7)',
              'rgba(40, 159, 64, 0.7)',
              'rgba(210, 199, 199, 0.7)',
            ],
          }]
        };
        
        chartOptions = {
          responsive: true,
          plugins: {
            legend: {
              position: 'top',
            },
            title: {
              display: true,
              text: title
            }
          }
        };
      } 
      else if (chartType === 'scatter') {
        // For scatter plots, we need x and y numeric values
        const scatterData = data.map(row => ({
          x: Number(row[xColumn]),
          y: Number(row[yColumn])
        }));
        
        chartData = {
          datasets: [{
            label: `${yColumn} vs ${xColumn}`,
            data: scatterData,
            backgroundColor: 'rgba(75, 192, 192, 0.7)',
          }]
        };
        
        chartOptions = {
          responsive: true,
          plugins: {
            legend: {
              position: 'top',
            },
            title: {
              display: true,
              text: title
            }
          },
          scales: {
            x: {
              title: {
                display: true,
                text: xColumn
              }
            },
            y: {
              title: {
                display: true,
                text: yColumn
              }
            }
          }
        };
      }
      else {
        // For bar and line charts
        // If there are too many data points, limit to first 20 for readability
        const limitedData = data.length > 20 ? data.slice(0, 20) : data;
        
        const labels = limitedData.map(row => row[xColumn]);
        const values = limitedData.map(row => row[yColumn]);
        
        chartData = {
          labels,
          datasets: [{
            label: yColumn,
            data: values,
            backgroundColor: 'rgba(75, 192, 192, 0.7)',
            borderColor: 'rgba(75, 192, 192, 1)',
            borderWidth: 1
          }]
        };
        
        chartOptions = {
          responsive: true,
          plugins: {
            legend: {
              position: 'top',
            },
            title: {
              display: true,
              text: title
            }
          },
          scales: {
            y: {
              beginAtZero: true
            }
          }
        };
      }
      
      const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    .chart-container {
      position: relative;
      height: 60vh;
      width: 100%;
    }
    h1 {
      text-align: center;
      color: #333;
    }
    .data-table {
      margin-top: 30px;
      width: 100%;
      border-collapse: collapse;
    }
    .data-table th, .data-table td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: left;
    }
    .data-table th {
      background-color: #f2f2f2;
    }
    .data-table tr:nth-child(even) {
      background-color: #f9f9f9;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <div class="chart-container">
      <canvas id="myChart"></canvas>
    </div>
    
    <h2>Data Table (First 10 Rows)</h2>
    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            ${columns.map(col => `<th>${col}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${data.slice(0, 10).map(row => `
            <tr>
              ${columns.map(col => `<td>${row[col]}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    // Chart data
    const chartData = ${JSON.stringify(chartData)};
    const chartOptions = ${JSON.stringify(chartOptions)};
    
    // Create chart
    const ctx = document.getElementById('myChart').getContext('2d');
    new Chart(ctx, {
      type: '${chartType}',
      data: chartData,
      options: chartOptions
    });
  </script>
</body>
</html>
`;

      return {
        content: [{ type: "text", text: htmlTemplate }],
        isError: false,
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          content: [{ type: "text", text: `Error generating visualization: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  }
  else if (request.params.name === "get_schema_insights") {
    const targetDataset = request.params.arguments?.dataset as string | undefined;
    
    try {
      // Get all datasets or filter by the specified dataset
      const [datasets] = await bigquery.getDatasets();
      const filteredDatasets = targetDataset 
        ? datasets.filter((d: any) => d.id === targetDataset)
        : datasets;
      
      if (filteredDatasets.length === 0) {
        return {
          content: [{ 
            type: "text", 
            text: targetDataset 
              ? `Dataset "${targetDataset}" not found.` 
              : "No datasets found in this project." 
          }],
          isError: true,
        };
      }
      
      // Collect schema information
      const schemaInfo: Array<any> = [];
      const tableRelationships: Array<any> = [];
      
      for (const dataset of filteredDatasets) {
        const [tables] = await dataset.getTables();
        
        // Process each table to extract schema information
        for (const table of tables) {
          const [metadata] = await table.getMetadata();
          const resourceType = metadata.type === 'VIEW' ? 'view' : 'table';
          
          // Extract field information
          const fields = metadata.schema?.fields?.map((f: any) => ({
            name: f.name,
            type: f.type,
            mode: f.mode || 'NULLABLE',
            description: f.description || ''
          })) || [];
          
          schemaInfo.push({
            dataset: dataset.id,
            name: table.id,
            type: resourceType,
            fields: fields,
            rowCount: metadata.numRows || 'unknown'
          });
          
          // Look for potential relationships based on field names
          // This is a simple heuristic - in a real implementation, you might use more sophisticated methods
          fields.forEach((field: any) => {
            // Look for fields that might be foreign keys (e.g., user_id, product_id)
            if (field.name.endsWith('_id') && field.name !== 'id') {
              const possibleTableName = field.name.replace('_id', '');
              tableRelationships.push({
                sourceTable: `${dataset.id}.${table.id}`,
                sourceField: field.name,
                possibleTargetTable: possibleTableName,
                relationshipType: 'possible foreign key'
              });
            }
          });
        }
      }
      
      // Generate insights about the schema
      const insights = `
## Schema Insights

**Overview:**
- Total datasets: ${filteredDatasets.length}
- Total tables/views: ${schemaInfo.length}
- Tables: ${schemaInfo.filter(t => t.type === 'table').length}
- Views: ${schemaInfo.filter(t => t.type === 'view').length}

**Tables and Fields:**
${schemaInfo.map(table => `
### ${table.dataset}.${table.name} (${table.type})
- Row count: ${table.rowCount}
- Fields (${table.fields.length}):
${table.fields.map((field: any) => `  - ${field.name} (${field.type}${field.mode === 'REQUIRED' ? ', required' : ''})`).join('\n')}
`).join('\n')}

${tableRelationships.length > 0 ? `
**Potential Relationships:**
${tableRelationships.map(rel => `- ${rel.sourceTable}.${rel.sourceField} → possible reference to ${rel.possibleTargetTable} table`).join('\n')}
` : ''}

**Recommendations:**
- ${schemaInfo.length > 10 ? 'Consider organizing related tables into separate datasets for better management' : 'Current organization looks good with a manageable number of tables'}
- ${tableRelationships.length > 0 ? 'Verify the identified potential relationships and consider using them in JOIN operations' : 'No obvious relationships detected, consider manual review of schema'}
- ${schemaInfo.some(t => t.fields.length > 20) ? 'Some tables have a large number of columns, consider reviewing for normalization opportunities' : 'Table structures appear reasonably normalized'}
`;

      return {
        content: [{ type: "text", text: insights }],
        isError: false,
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          content: [{ type: "text", text: `Error analyzing schema: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

async function runServer() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('BigQuery MCP server running on stdio');
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
    } else {
      console.error('An unknown error occurred:', error);
    }
    process.exit(1);
  }
}

runServer().catch(console.error);
